/**
 * Verifica el cliente JSON-RPC contra un servidor que imita las respuestas de
 * Odoo: forma exacta del payload, construcción de dominios, y los errores que
 * más rompen en la práctica (contraseña incorrecta, 2FA, 404, HTML, error de
 * Odoo con HTTP 200).
 *
 *   node test/odoo.test.mjs
 */
import esbuild from 'esbuild';
import http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

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
  detectSchema,
  searchTasks,
  resolveEmployeeId,
  createTimesheetLines,
} = require(path.join(TMP, 'odoo.cjs'));

// --- Servidor que imita a Odoo ----------------------------------------------
const received = [];
let scenario = 'ok';

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    if (scenario === 'html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html>login page</html>');
      return;
    }
    if (scenario === '404') {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<html>Not Found</html>');
      return;
    }

    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    received.push({ url: req.url, body });

    const { service, method, args } = body.params;
    const reply = (payload) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...payload }));
    };

    if (service === 'common' && method === 'version') {
      return reply({ result: { server_version: '18.0+e' } });
    }
    if (service === 'common' && method === 'authenticate') {
      return reply({ result: scenario === 'badpass' ? false : 7 });
    }
    if (service === 'db' && method === 'list') {
      return reply({ result: ['produccion', 'staging'] });
    }
    if (service !== 'object' || method !== 'execute_kw') {
      return reply({ result: null });
    }

    const [, , , model, modelMethod, positional] = args;

    if (scenario === 'odooerror') {
      return reply({
        error: {
          code: 200,
          message: 'Odoo Server Error',
          data: {
            name: 'odoo.exceptions.ValidationError',
            message: 'Timesheets must be created with an active employee.',
            debug: 'Traceback (most recent call last): ...',
          },
        },
      });
    }
    if (scenario === 'accessdenied') {
      return reply({
        error: { code: 200, data: { name: 'odoo.exceptions.AccessDenied', message: 'Access Denied' } },
      });
    }

    if (model === 'project.task' && modelMethod === 'fields_get') {
      return reply({
        result:
          scenario === 'legacy'
            ? { user_id: { type: 'many2one' }, stage_id: { type: 'many2one' } }
            : {
                user_ids: { type: 'many2many' },
                user_id: { type: 'many2one' },
                stage_id: { type: 'many2one' },
              },
      });
    }
    if (model === 'project.task' && modelMethod === 'search_read') {
      return reply({
        result: [
          {
            id: 4821,
            name: 'Portal de clientes',
            project_id: [12, 'Peyo Web'],
            stage_id: [3, 'En curso'],
            write_date: '2026-08-29 18:02:11',
          },
        ],
      });
    }
    if (model === 'hr.employee' && modelMethod === 'search_read') {
      if (scenario === 'noemployee') {
        return reply({ result: [] });
      }
      if (scenario === 'employee-restricted') {
        return reply({
          error: {
            code: 200,
            data: { name: 'odoo.exceptions.AccessError', message: 'Sin acceso a hr.employee' },
          },
        });
      }
      return reply({ result: [{ id: 33, name: 'Dev Test' }] });
    }
    if (model === 'hr.employee.public' && modelMethod === 'search_read') {
      return reply({ result: [{ id: 33, name: 'Dev Test' }] });
    }
    if (model === 'account.analytic.line' && modelMethod === 'create') {
      // Odoo devuelve `recs.ids` (lista) cuando el argumento es una lista.
      return reply({
        result: scenario === 'single-id' ? 501 : positional[0].map((_, index) => 500 + index),
      });
    }
    return reply({ result: [] });
  });
});

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
const lastCall = () => received[received.length - 1].body;
const connectedClient = async () => {
  const fresh = new OdooClient(credentials, silent);
  await fresh.authenticate();
  return fresh;
};

// --- normalizeBaseUrl --------------------------------------------------------
assert.equal(normalizeBaseUrl('miempresa.odoo.com'), 'https://miempresa.odoo.com');
assert.equal(normalizeBaseUrl('https://miempresa.odoo.com/'), 'https://miempresa.odoo.com');
assert.equal(normalizeBaseUrl('https://miempresa.odoo.com/web'), 'https://miempresa.odoo.com');
assert.equal(normalizeBaseUrl('https://miempresa.odoo.com/odoo/'), 'https://miempresa.odoo.com');
assert.equal(normalizeBaseUrl('http://localhost:8069'), 'http://localhost:8069');
assert.throws(() => normalizeBaseUrl('   '), OdooError);

// --- Autenticación -----------------------------------------------------------
const client = new OdooClient(credentials, silent);
assert.equal(await client.authenticate(), 7);
assert.equal(received[0].url, '/jsonrpc');

const authCall = lastCall();
assert.equal(authCall.jsonrpc, '2.0');
assert.equal(authCall.method, 'call');
assert.equal(authCall.params.service, 'common');
assert.deepEqual(
  authCall.params.args,
  ['produccion', 'dev@example.com', 'apikey', {}],
  'authenticate necesita el 4º argumento (env del cliente)',
);

// --- execute_kw --------------------------------------------------------------
await client.searchRead('res.partner', [['id', '=', 1]], ['name'], { limit: 5, order: 'name asc' });
const kwCall = lastCall();
assert.equal(kwCall.params.method, 'execute_kw');
const [db, uid, password, model, modelMethod, positional, kwargs] = kwCall.params.args;
assert.deepEqual([db, uid, password, model, modelMethod], [
  'produccion',
  7,
  'apikey',
  'res.partner',
  'search_read',
]);
assert.deepEqual(positional, [[['id', '=', 1]]]);
assert.deepEqual(kwargs, { fields: ['name'], limit: 5, order: 'name asc' });

// --- Detección de esquema ----------------------------------------------------
const schema = await detectSchema(client, silent);
assert.equal(schema.serverVersion, '18.0+e');
assert.equal(schema.assigneeField, 'user_ids');
assert.equal(schema.hasStage, true);

scenario = 'legacy';
const legacySchema = await detectSchema(await connectedClient(), silent);
assert.equal(legacySchema.assigneeField, 'user_id', 'Odoo ≤15 debe detectarse como user_id');
scenario = 'ok';

// --- Dominios de búsqueda ----------------------------------------------------
await searchTasks(client, schema, { scope: 'assigned', limit: 50 });
assert.deepEqual(lastCall().params.args[5][0], [['user_ids', 'in', [7]]]);

await searchTasks(client, legacySchema, { scope: 'assigned', limit: 50 });
assert.deepEqual(lastCall().params.args[5][0], [['user_id', 'in', [7]]]);

await searchTasks(client, schema, { scope: 'assigned', query: 'portal', limit: 50 });
assert.deepEqual(lastCall().params.args[5][0], [
  ['user_ids', 'in', [7]],
  ['name', 'ilike', 'portal'],
]);

await searchTasks(client, schema, { scope: 'assigned', query: '4821', limit: 50 });
assert.deepEqual(
  lastCall().params.args[5][0],
  [['user_ids', 'in', [7]], '|', ['id', '=', 4821], ['name', 'ilike', '4821']],
  'una búsqueda numérica debe permitir id OR nombre, en notación prefija',
);
assert.equal(lastCall().params.args[6].order, 'write_date desc');

await searchTasks(client, schema, { scope: 'all', limit: 10 });
assert.deepEqual(lastCall().params.args[5][0], [], 'scope=all no debe filtrar por asignado');

// --- Empleado ----------------------------------------------------------------
await assert.rejects(
  () => resolveEmployeeId(new OdooClient(credentials, silent)),
  (error) => error instanceof OdooError && error.kind === 'auth',
  'sin sesión autenticada debe fallar de forma explícita',
);
assert.equal(await resolveEmployeeId(client), 33);

scenario = 'employee-restricted';
assert.equal(
  await resolveEmployeeId(await connectedClient()),
  33,
  'sin permiso sobre hr.employee debe caer a hr.employee.public',
);

scenario = 'noemployee';
await assert.rejects(
  async () => resolveEmployeeId(await connectedClient()),
  (error) => error instanceof OdooError && /no tiene un empleado asociado/.test(error.message),
  'un usuario sin empleado necesita un mensaje accionable',
);
scenario = 'ok';

// --- Creación de líneas ------------------------------------------------------
const lines = [
  { date: '2026-08-29', description: 'fix: login', hours: 2.5, taskId: 4821, projectId: 12 },
  { date: '2026-08-30', description: 'feat: guard', hours: 1, taskId: 4821, projectId: 12 },
];
assert.deepEqual(await createTimesheetLines(client, 33, lines), [500, 501]);
assert.deepEqual(lastCall().params.args[5][0], [
  {
    date: '2026-08-29',
    name: 'fix: login',
    unit_amount: 2.5,
    task_id: 4821,
    project_id: 12,
    employee_id: 33,
  },
  {
    date: '2026-08-30',
    name: 'feat: guard',
    unit_amount: 1,
    task_id: 4821,
    project_id: 12,
    employee_id: 33,
  },
]);

scenario = 'single-id';
assert.deepEqual(
  await createTimesheetLines(client, 33, [lines[0]]),
  [501],
  'un id suelto debe normalizarse a lista',
);
scenario = 'ok';

// --- Errores -----------------------------------------------------------------
scenario = 'badpass';
await assert.rejects(
  () => new OdooClient(credentials, silent).authenticate(),
  (error) =>
    error instanceof OdooError &&
    error.kind === 'auth' &&
    /API key/.test(error.message) &&
    /dos pasos/.test(error.message),
  'authenticate devuelve false en vez de lanzar: hay que detectarlo y mencionar la API key',
);

scenario = 'odooerror';
await assert.rejects(
  () => new OdooClient(credentials, silent).searchRead('project.task', [], ['name']),
  (error) =>
    error instanceof OdooError &&
    error.kind === 'server' &&
    error.message === 'Timesheets must be created with an active employee.' &&
    /Traceback/.test(error.detail),
  'un error con HTTP 200 debe convertirse en el mensaje legible, no en el traceback',
);

scenario = 'accessdenied';
await assert.rejects(
  () => new OdooClient(credentials, silent).searchRead('project.task', [], ['name']),
  (error) => error instanceof OdooError && error.kind === 'auth',
);

scenario = '404';
await assert.rejects(
  () => new OdooClient(credentials, silent).version(),
  (error) => error instanceof OdooError && error.kind === 'transport' && /404/.test(error.message),
);

scenario = 'html';
await assert.rejects(
  () => new OdooClient(credentials, silent).version(),
  (error) =>
    error instanceof OdooError && error.kind === 'transport' && /no es JSON/.test(error.message),
  'una URL que devuelve HTML debe explicarse, no reventar en JSON.parse',
);
scenario = 'ok';

// --- Varios ------------------------------------------------------------------
assert.deepEqual(await OdooClient.listDatabases(base, false), ['produccion', 'staging']);

await assert.rejects(
  () => new OdooClient({ ...credentials, url: 'http://no-existe.invalid' }, silent).version(),
  (error) => error instanceof OdooError && error.kind === 'network',
);

server.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`✅ odoo: ${received.length} llamadas RPC verificadas contra el servidor simulado.`);
