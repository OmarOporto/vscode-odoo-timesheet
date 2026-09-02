/**
 * Verifica los dos transportes y la lógica de tareas contra un servidor que
 * imita a Odoo (ver test/fixtures/odoo-server.mjs) con datos que reproducen el
 * caso real: tareas con horas imputadas pero sin nadie en Asignados.
 *
 *   node test/odoo.test.mjs
 */
import esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createOdooServer, UID } from './fixtures/odoo-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const TMP = path.join(HERE, '.tmp-odoo');

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(HERE, 'fixtures', 'odoo-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: path.join(TMP, 'odoo.cjs'),
  absWorkingDir: PROJECT,
  logLevel: 'error',
});

const require = createRequire(import.meta.url);
const {
  OdooClient,
  OdooError,
  normalizeBaseUrl,
  parseMajorVersion,
  detectSchema,
  searchTasks,
  listProjects,
  createTask,
  orderClause,
  recordUrl,
  resolveEmployeeId,
  createTimesheetLines,
  diagnoseMissingTasks,
  formatTaskDate,
  CommitRegistry,
  pruneRegistry,
  REGISTRY_KEY,
} = require(path.join(TMP, 'odoo.cjs'));

const odoo = createOdooServer();
const { server, received, lastCall, lastWire, setScenario, resetTasks } = odoo;
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const base = `http://127.0.0.1:${server.address().port}`;
const credentials = {
  url: base,
  db: 'produccion',
  username: 'dev@example.com',
  password: 'apikey',
  allowInsecureTLS: false,
};
const silent = () => {};
const ids = (tasks) => tasks.map((task) => task.id);
const callsFor = (model, method) =>
  received.filter((call) => call.model === model && call.method === method);

// ---------------------------------------------------------------------------
// Utilidades puras
// ---------------------------------------------------------------------------
assert.equal(
  normalizeBaseUrl('https://odoo19.example.com/odoo/timesheets/project.task/2488'),
  'https://odoo19.example.com',
  'pegar la URL de una tarea debe recortarse hasta la base',
);
assert.equal(
  normalizeBaseUrl('https://host/web#id=5&model=project.task&view_type=form'),
  'https://host',
);
assert.equal(
  normalizeBaseUrl('https://host/erp/odoo/timesheets/project.task/2488'),
  'https://host/erp',
  'una instancia bajo subruta conserva su prefijo',
);
assert.equal(normalizeBaseUrl('miempresa.odoo.com'), 'https://miempresa.odoo.com');
assert.equal(normalizeBaseUrl('http://localhost:8069'), 'http://localhost:8069');
assert.throws(() => normalizeBaseUrl('   '), OdooError);

assert.equal(parseMajorVersion('19.0.1.3'), 19);
assert.equal(parseMajorVersion('saas~17.2+e'), 17);

assert.equal(
  recordUrl('https://odoo19.example.com', 19, 'project.task', 2488),
  'https://odoo19.example.com/odoo/project.task/2488',
);
assert.equal(
  recordUrl('https://host', 16, 'project.task', 5),
  'https://host/web#id=5&model=project.task&view_type=form',
  'antes de la 17 hay que usar el hash del cliente viejo',
);

assert.equal(formatTaskDate('2026-08-26', 'MM/DD'), '08/26');
assert.equal(formatTaskDate('2026-08-26', 'DD/MM'), '26/08');
assert.equal(formatTaskDate('2026-08-26', 'YYYY-MM-DD'), '2026-08-26');
assert.equal(formatTaskDate('2026-08-26', ''), '', 'sin formato, sin prefijo');

// ---------------------------------------------------------------------------
// Registro de commits ya imputados
// ---------------------------------------------------------------------------
function fakeStore(initial = {}) {
  const data = { [REGISTRY_KEY]: initial };
  return {
    saved: 0,
    get(key, fallback) {
      return key in data ? data[key] : fallback;
    },
    update(key, value) {
      data[key] = value;
      this.saved += 1;
      return Promise.resolve();
    },
    raw: () => data[REGISTRY_KEY],
  };
}

const info = (overrides = {}) => ({
  taskId: 2488,
  taskName: '08/29 Fix Alejandro Bridge',
  hours: 2.5,
  day: '2026-08-29',
  at: '2026-08-29T18:00:00.000Z',
  ...overrides,
});

{
  const store = fakeStore();
  const registry = new CommitRegistry(store);

  assert.equal(registry.isRegistered('abc'), false, 'un hash desconocido no está registrado');
  assert.equal(registry.get('abc'), undefined);
  assert.equal(registry.size, 0);

  await registry.record([
    { hash: 'aaa', info: info() },
    { hash: 'bbb', info: info({ hours: 8 }) },
  ]);
  assert.equal(registry.isRegistered('aaa'), true);
  assert.equal(registry.get('bbb').hours, 8);
  assert.equal(registry.size, 2);

  // Registrar de nuevo el mismo hash sobrescribe, no duplica.
  await registry.record([{ hash: 'aaa', info: info({ hours: 4, taskId: 9999 }) }]);
  assert.equal(registry.size, 2);
  assert.equal(registry.get('aaa').hours, 4);
  assert.equal(registry.get('aaa').taskId, 9999);

  // Lo persistido debe ser JSON plano para sobrevivir a la sincronización.
  assert.deepEqual(JSON.parse(JSON.stringify(store.raw())), store.raw());

  await registry.forget(['aaa']);
  assert.equal(registry.isRegistered('aaa'), false);
  assert.equal(registry.isRegistered('bbb'), true, 'olvidar uno no toca a los demás');

  const before = store.saved;
  await registry.forget(['no-existe']);
  assert.equal(store.saved, before, 'olvidar algo inexistente no escribe');

  await registry.record([]);
  assert.equal(store.saved, before, 'registrar una lista vacía tampoco escribe');

  await registry.clear();
  assert.equal(registry.size, 0);
}

{
  // Se relee lo que dejó una sesión anterior.
  const store = fakeStore({ ccc: info() });
  const registry = new CommitRegistry(store);
  assert.equal(registry.isRegistered('ccc'), true, 'el estado guardado se recupera');
}

{
  // La poda conserva los más recientes por `at`.
  const map = {
    viejo: info({ at: '2026-01-01T00:00:00.000Z' }),
    medio: info({ at: '2026-06-01T00:00:00.000Z' }),
    nuevo: info({ at: '2026-08-31T00:00:00.000Z' }),
  };
  assert.deepEqual(Object.keys(pruneRegistry(map, 2)).sort(), ['medio', 'nuevo']);
  assert.equal(pruneRegistry(map, 3), map, 'por debajo del tope devuelve el mismo objeto');

  // Empate en `at`: debe podar de forma determinista, no al azar.
  const tie = {
    bbb: info({ at: '2026-08-31T00:00:00.000Z' }),
    aaa: info({ at: '2026-08-31T00:00:00.000Z' }),
    ccc: info({ at: '2026-08-31T00:00:00.000Z' }),
  };
  const first = Object.keys(pruneRegistry(tie, 2)).sort();
  const second = Object.keys(pruneRegistry({ ...tie }, 2)).sort();
  assert.deepEqual(first, second, 'la poda con empates es estable');
  assert.equal(first.length, 2);
}

assert.equal(orderClause('created'), 'create_date desc');
assert.equal(orderClause('updated'), 'write_date desc');
assert.equal(orderClause('name'), 'name asc');
assert.equal(orderClause(undefined), 'create_date desc', 'por defecto, por creación');

// ---------------------------------------------------------------------------
// Aserciones de negocio, iguales para los dos transportes
// ---------------------------------------------------------------------------
async function sharedAssertions(client, label) {
  const schema = await detectSchema(client, silent);
  assert.equal(schema.assigneeField, 'user_ids', label);
  assert.equal(schema.hasTimesheetIds, true, label);
  assert.equal(schema.hasEffectiveHours, true, label);
  assert.equal(schema.hasTaskCount, true, label);

  // --- Forma del dominio ---------------------------------------------------
  await searchTasks(client, schema, { scope: 'mine', limit: 50 });
  assert.deepEqual(
    lastCall().params.domain,
    ['|', ['user_ids', 'in', [UID]], ['timesheet_ids.user_id', '=', UID]],
    `${label}: scope mine`,
  );
  assert.equal(lastCall().params.order, 'create_date desc', `${label}: orden por creación`);

  await searchTasks(client, schema, { scope: 'mine', limit: 50, projectId: 12, query: '2488' });
  assert.deepEqual(
    lastCall().params.domain,
    [
      ['project_id', '=', 12],
      '|',
      ['user_ids', 'in', [UID]],
      ['timesheet_ids.user_id', '=', UID],
      '|',
      ['id', '=', 2488],
      ['name', 'ilike', '2488'],
    ],
    `${label}: proyecto AND (asignado OR imputado) AND (id OR nombre)`,
  );

  await searchTasks(client, schema, { scope: 'all', limit: 10 });
  assert.deepEqual(lastCall().params.domain, [], `${label}: scope=all no filtra`);

  // --- Comportamiento: EL CASO REAL ---------------------------------------
  const assigned = await searchTasks(client, schema, { scope: 'assigned', limit: 50, projectId: 12 });
  assert.deepEqual(
    ids(assigned),
    [2500],
    `${label}: con scope "assigned" se pierden las tareas donde solo imputaste horas`,
  );

  const mine = await searchTasks(client, schema, { scope: 'mine', limit: 50, projectId: 12 });
  assert.deepEqual(
    ids(mine),
    [2500, 2488, 2487],
    `${label}: con scope "mine" aparecen también las tareas con horas mías`,
  );
  assert.equal(mine[1].effective_hours, 4, `${label}: se traen las horas ya imputadas`);

  const onlyTimesheet = await searchTasks(client, schema, { scope: 'timesheet', limit: 50 });
  assert.deepEqual(
    ids(onlyTimesheet),
    [2488, 2487, 2410],
    `${label}: scope "timesheet" trae solo donde hay horas mías, y nunca la archivada`,
  );

  // --- Orden: creación vs modificación ------------------------------------
  // La 2487 es la más antigua de las tres pero fue tocada hoy: con "updated" se
  // cuela la primera, que es exactamente lo que no queremos.
  const byUpdated = await searchTasks(client, schema, {
    scope: 'mine',
    order: 'updated',
    limit: 50,
    projectId: 12,
  });
  assert.equal(lastCall().params.order, 'write_date desc', label);
  assert.deepEqual(ids(byUpdated), [2487, 2500, 2488], `${label}: orden por modificación`);

  const byName = await searchTasks(client, schema, {
    scope: 'mine',
    order: 'name',
    limit: 50,
    projectId: 12,
  });
  assert.equal(lastCall().params.order, 'name asc', label);
  assert.deepEqual(ids(byName), [2487, 2488, 2500], `${label}: orden alfabético`);

  // --- Paginación: se pide una de más para saber si hay «Mostrar más» ------
  const firstPage = await searchTasks(client, schema, {
    scope: 'mine',
    limit: 2 + 1,
    projectId: 12,
  });
  assert.equal(firstPage.length, 3, `${label}: vuelve la extra, así que hay más de 2`);
  assert.deepEqual(ids(firstPage).slice(0, 2), [2500, 2488], `${label}: la página son las 2 primeras`);

  const lastPage = await searchTasks(client, schema, {
    scope: 'mine',
    limit: 10 + 1,
    projectId: 12,
  });
  assert.equal(lastPage.length, 3, `${label}: no vuelve la extra, así que no hay más`);

  // --- Proyectos -----------------------------------------------------------
  const projects = await listProjects(client, schema, { limit: 200 });
  assert.deepEqual(lastCall().params.domain, [['allow_timesheets', '=', true]], label);
  assert.deepEqual(
    projects.map((entry) => entry.id),
    [12, 18],
    `${label}: un proyecto sin hojas de horas no se lista`,
  );

  assert.equal(await resolveEmployeeId(client), 33, label);

  // --- Líneas de horas -----------------------------------------------------
  const lines = [
    { date: '2026-08-29', description: 'fix: login', hours: 2.5, taskId: 2488, projectId: 12 },
    { date: '2026-08-30', description: 'feat: guard', hours: 1, taskId: 2488, projectId: 12 },
  ];
  assert.deepEqual(await createTimesheetLines(client, 33, lines), [500, 501], label);
  assert.deepEqual(
    lastCall().params.vals_list,
    [
      { date: '2026-08-29', name: 'fix: login', unit_amount: 2.5, task_id: 2488, project_id: 12, employee_id: 33 },
      { date: '2026-08-30', name: 'feat: guard', unit_amount: 1, task_id: 2488, project_id: 12, employee_id: 33 },
    ],
    label,
  );

  setScenario('single-id');
  assert.deepEqual(
    await createTimesheetLines(client, 33, [lines[0]]),
    [501],
    `${label}: un id suelto se normaliza a lista`,
  );
  setScenario('ok');

  return schema;
}

// ---- JSON-2 ----------------------------------------------------------------
const json2 = await OdooClient.connect(credentials, 'auto', silent);
assert.equal(json2.api, 'json2', 'con /json/2 disponible debe elegirse JSON-2');
assert.equal(json2.userId, UID);
assert.equal(json2.login, 'dev@example.com', 'el login lo descubre el servidor');
assert.equal(json2.serverVersion, '19.0.1.3');
assert.equal(json2.majorVersion, 19);

await json2.searchRead('res.partner', [['id', '=', 1]], ['name'], { limit: 5 });
assert.equal(lastWire().url, '/json/2/res.partner/search_read');
assert.equal(lastWire().headers.authorization, 'bearer apikey');
assert.equal(lastWire().headers['x-odoo-database'], 'produccion');
assert.deepEqual(
  lastWire().body,
  { domain: [['id', '=', 1]], fields: ['name'], limit: 5 },
  'JSON-2 usa un único objeto de parámetros nombrados',
);

const schema = await sharedAssertions(json2, 'json2');

const noDb = await OdooClient.connect({ ...credentials, db: '' }, 'auto', silent);
assert.equal(noDb.db, undefined);
assert.equal(lastWire().headers['x-odoo-database'], undefined, 'sin db no se manda la cabecera');

// ---- JSON-RPC --------------------------------------------------------------
const jsonrpc = await OdooClient.connect(credentials, 'jsonrpc', silent);
assert.equal(jsonrpc.api, 'jsonrpc');
assert.equal(jsonrpc.serverVersion, '18.0+e');
assert.equal(jsonrpc.majorVersion, 18);

const authCall = odoo.wire.find(
  (entry) => entry.url === '/jsonrpc' && entry.body?.params?.method === 'authenticate',
);
assert.deepEqual(
  authCall.body.params.args,
  ['produccion', 'dev@example.com', 'apikey', {}],
  'authenticate necesita el 4º argumento (env del cliente)',
);

await jsonrpc.searchRead('res.partner', [['id', '=', 1]], ['name'], { limit: 5 });
const [db, uid, password, model, method, positional, kwargs] = lastWire().body.params.args;
assert.deepEqual([db, uid, password, model, method], ['produccion', UID, 'apikey', 'res.partner', 'search_read']);
assert.deepEqual(positional, [[['id', '=', 1]]]);
assert.deepEqual(kwargs, { fields: ['name'], limit: 5 });

await sharedAssertions(jsonrpc, 'jsonrpc');

// ---------------------------------------------------------------------------
// Diagnóstico: por qué no aparecen las tareas
// ---------------------------------------------------------------------------
const withAssigned = await diagnoseMissingTasks(json2, schema, {
  scope: 'assigned',
  order: 'created',
  daysBack: 60,
  tasksPerProject: 50,
});

assert.equal(withAssigned.linesFound, 4, 'solo mis líneas dentro de la ventana de 60 días');
assert.deepEqual(
  withAssigned.tasks.map((task) => task.taskId),
  [2488, 2487, 2410, 2400],
  'las tareas se ordenan por imputación más reciente',
);
assert.equal(withAssigned.tasks[0].loggedHours, 4);
assert.equal(withAssigned.tasks[0].projectName, 'DEV EQUIPO');
assert.equal(
  withAssigned.tasks.every((task) => !task.visible),
  true,
  'con scope "assigned" ninguna de las cuatro llega al panel',
);

const [fix, arreglos, sinTimesheets, archivada] = withAssigned.tasks;
assert.match(fix.reasons.join(' '), /taskScope = "assigned"/);
assert.match(
  fix.reasons.join(' '),
  /no tiene a nadie en Asignados/,
  'debe señalar la causa exacta: la tarea no tiene asignados',
);
assert.match(arreglos.reasons.join(' '), /no tiene a nadie en Asignados/);
assert.match(archivada.reasons.join(' '), /archivada/);
assert.match(sinTimesheets.reasons.join(' '), /allow_timesheets/);

assert.ok(
  withAssigned.suggestions.some((text) => text.includes('"odooTimesheet.taskScope": "mine"')),
  'la sugerencia principal debe ser cambiar el scope a "mine"',
);
assert.ok(withAssigned.suggestions.some((text) => text.includes('archivadas')));
assert.ok(withAssigned.suggestions.some((text) => text.includes('hojas de horas')));

// Con el scope corregido, las dos del caso real dejan de estar ocultas.
const withMine = await diagnoseMissingTasks(json2, schema, {
  scope: 'mine',
  order: 'created',
  daysBack: 60,
  tasksPerProject: 50,
});
const visibleIds = withMine.tasks.filter((task) => task.visible).map((task) => task.taskId);
assert.deepEqual(visibleIds, [2488, 2487], 'con "mine" las tareas con horas mías ya se ven');
assert.match(
  withMine.tasks.find((task) => task.taskId === 2400).reasons.join(' '),
  /archivada/,
  'la archivada sigue oculta, y por su motivo propio',
);

// El límite por proyecto también se detecta.
const withLimit = await diagnoseMissingTasks(json2, schema, {
  scope: 'mine',
  order: 'created',
  daysBack: 60,
  tasksPerProject: 1,
});
assert.match(
  withLimit.tasks.find((task) => task.taskId === 2487).reasons.join(' '),
  /fuera de las 1 tareas que el panel muestra por proyecto/,
  'una tarea que no cabe en la página del proyecto debe reportarse como tal',
);
assert.ok(withLimit.suggestions.some((text) => text.includes('tasksPerProject')));
assert.ok(withLimit.suggestions.some((text) => text.includes('Mostrar más')));

// Ventana sin imputaciones (la más reciente del fixture es de ayer, así que
// solo una ventana que empiece hoy la deja fuera).
const empty = await diagnoseMissingTasks(json2, schema, {
  scope: 'mine',
  order: 'created',
  daysBack: 0,
  tasksPerProject: 50,
});
assert.equal(empty.tasks.length, 0);
assert.match(empty.suggestions.join(' '), /No hay imputaciones tuyas/);

// Una ventana estrecha pero real sí recoge lo de ayer.
const yesterdayOnly = await diagnoseMissingTasks(json2, schema, {
  scope: 'mine',
  order: 'created',
  daysBack: 1,
  tasksPerProject: 50,
});
assert.deepEqual(
  yesterdayOnly.tasks.map((task) => task.taskId),
  [2488],
  'la ventana de 1 día incluye las imputaciones de ayer',
);

// El diagnóstico funciona igual por el transporte antiguo.
const viaJsonRpc = await diagnoseMissingTasks(jsonrpc, schema, {
  scope: 'assigned',
  order: 'created',
  daysBack: 60,
  tasksPerProject: 50,
});
assert.deepEqual(
  viaJsonRpc.tasks.map((task) => task.taskId),
  [2488, 2487, 2410, 2400],
  'jsonrpc: mismo diagnóstico',
);

// ---------------------------------------------------------------------------
// Crear tareas
// ---------------------------------------------------------------------------
const created = await createTask(json2, schema, {
  name: '08/30 fix login redirect; add user guard',
  projectId: 12,
  assignToMe: true,
});
assert.equal(created.name, '08/30 fix login redirect; add user guard');
assert.deepEqual(created.project_id, [12, 'DEV EQUIPO']);
assert.deepEqual(
  callsFor('project.task', 'create').at(-1).params.vals_list[0].user_ids,
  [[6, 0, [UID]]],
  'asignarse usa el comando x2many (6, 0, ids)',
);

await createTask(json2, schema, { name: 'Sin asignar', projectId: 12, assignToMe: false });
const withoutAssignee = callsFor('project.task', 'create').at(-1).params.vals_list[0];
assert.equal(withoutAssignee.user_ids, undefined, 'con assignToMe:false no se toca Asignados');
assert.equal(withoutAssignee.user_id, undefined);

resetTasks();

// ---------------------------------------------------------------------------
// Esquema antiguo
// ---------------------------------------------------------------------------
setScenario('legacy');
const legacySchema = await detectSchema(jsonrpc, silent);
assert.equal(legacySchema.assigneeField, 'user_id', 'Odoo ≤15 se detecta como user_id');
assert.equal(legacySchema.hasTimesheetIds, false);
assert.equal(legacySchema.hasTaskCount, false);

await searchTasks(jsonrpc, legacySchema, { scope: 'mine', limit: 50 });
assert.deepEqual(
  lastCall().params.domain,
  [['user_id', 'in', [UID]]],
  'sin timesheet_ids, "mine" degrada a asignadas en vez de reventar',
);
await searchTasks(jsonrpc, legacySchema, { scope: 'timesheet', limit: 50 });
assert.deepEqual(lastCall().params.domain, [['user_id', 'in', [UID]]], '"timesheet" también degrada');

await listProjects(jsonrpc, legacySchema, { limit: 200 });
assert.deepEqual(lastCall().params.fields, ['name'], 'sin task_count no se pide ese campo');
setScenario('ok');

await createTask(jsonrpc, legacySchema, { name: 'Legacy', projectId: 12, assignToMe: true });
assert.equal(
  callsFor('project.task', 'create').at(-1).params.vals_list[0].user_id,
  UID,
  'en esquema antiguo la asignación es un Many2one',
);
resetTasks();

// ---------------------------------------------------------------------------
// Detección de transporte y caídas
// ---------------------------------------------------------------------------
setScenario('no-json2');
assert.equal(
  (await OdooClient.connect(credentials, 'auto', silent)).api,
  'jsonrpc',
  'un 404 en /json/2 debe caer a /jsonrpc',
);
await assert.rejects(
  () => OdooClient.connect(credentials, 'json2', silent),
  (error) => error instanceof OdooError && error.status === 404,
  'forzando json2, un 404 debe propagarse en vez de caer',
);

setScenario('bad-apikey');
assert.equal(
  (await OdooClient.connect(credentials, 'auto', silent)).api,
  'jsonrpc',
  'un 401 en JSON-2 (una contraseña en vez de API key) debe caer a /jsonrpc',
);
await assert.rejects(
  () => OdooClient.connect(credentials, 'json2', silent),
  (error) => error instanceof OdooError && error.kind === 'auth' && /API key/.test(error.message),
);
setScenario('ok');

// ---------------------------------------------------------------------------
// Empleado y errores
// ---------------------------------------------------------------------------
setScenario('employee-restricted');
assert.equal(
  await resolveEmployeeId(json2),
  33,
  'sin permiso sobre hr.employee debe caer a hr.employee.public',
);

setScenario('noemployee');
await assert.rejects(
  () => resolveEmployeeId(json2),
  (error) => error instanceof OdooError && /no tiene un empleado asociado/.test(error.message),
);

setScenario('badpass');
await assert.rejects(
  () => OdooClient.connect(credentials, 'jsonrpc', silent),
  (error) =>
    error instanceof OdooError &&
    error.kind === 'auth' &&
    /API key/.test(error.message) &&
    /dos pasos/.test(error.message),
  'authenticate devuelve false en vez de lanzar: hay que detectarlo',
);

setScenario('odooerror');
await assert.rejects(
  () => json2.searchRead('project.task', [], ['name']),
  (error) =>
    error instanceof OdooError &&
    error.kind === 'server' &&
    error.message === 'Timesheets must be created with an active employee.' &&
    /Traceback/.test(error.detail),
  'JSON-2 reporta el error por status con el mensaje legible',
);
await assert.rejects(
  () => jsonrpc.searchRead('project.task', [], ['name']),
  (error) => error instanceof OdooError && error.kind === 'server',
  'JSON-RPC lo reporta con HTTP 200 y el error en el cuerpo',
);

setScenario('accessdenied');
await assert.rejects(
  () => jsonrpc.searchRead('project.task', [], ['name']),
  (error) => error instanceof OdooError && error.kind === 'auth',
);

setScenario('404');
await assert.rejects(
  () => OdooClient.connect(credentials, 'jsonrpc', silent),
  (error) => error instanceof OdooError && error.kind === 'transport' && /404/.test(error.message),
);

setScenario('html');
await assert.rejects(
  () => OdooClient.connect(credentials, 'jsonrpc', silent),
  (error) => error instanceof OdooError && error.kind === 'transport' && /no es JSON/.test(error.message),
);
setScenario('ok');

assert.deepEqual(await OdooClient.listDatabases(base, false), ['produccion', 'staging']);
await assert.rejects(
  () => OdooClient.connect({ ...credentials, url: 'http://no-existe.invalid' }, 'auto', silent),
  (error) => error instanceof OdooError && error.kind === 'network',
  'un fallo de red no debe disfrazarse de caída de transporte',
);

server.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(
  `✅ odoo: ${received.length} llamadas verificadas (JSON-2 y JSON-RPC), incluido el diagnóstico del caso real.`,
);
