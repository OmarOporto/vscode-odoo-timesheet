/**
 * Servidor que imita a Odoo por sus dos APIs, con datos que reproducen el caso
 * real que motivó el diagnóstico: tareas con horas imputadas por el usuario
 * pero **sin nadie en Asignados**.
 *
 * Evalúa los dominios de verdad (notación prefija incluida), porque probar el
 * diagnóstico contra un servidor que los ignora no probaría nada.
 */
import http from 'node:http';

export const UID = 7;

const pad = (n) => String(n).padStart(2, '0');
/** `YYYY-MM-DD` a N días de hoy, para que el filtro por fecha sea realista. */
export function dayOffset(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const PROJECTS = [
  { id: 12, name: 'DEV EQUIPO', allow_timesheets: true, task_count: 3, active: true },
  { id: 18, name: 'Global Flow', allow_timesheets: true, task_count: 1, active: true },
  { id: 24, name: 'Proyecto sin horas', allow_timesheets: false, task_count: 1, active: true },
];

export const TASKS = [
  // Asignada a mí: se ve con cualquier scope.
  {
    id: 2500,
    name: 'Timesheets desde VS Code',
    project_id: [12, 'DEV EQUIPO'],
    stage_id: [3, 'En curso'],
    user_ids: [UID],
    user_id: [UID, 'Dev Test'],
    timesheet_ids: [],
    effective_hours: 0,
    create_date: '2026-08-30 09:00:00',
    write_date: '2026-08-30 10:00:00',
    active: true,
  },
  // EL CASO REAL: horas mías, pero Asignados vacío.
  {
    id: 2488,
    name: '08/29 Fix Alejandro Bridge. Completion P2P integration',
    project_id: [12, 'DEV EQUIPO'],
    stage_id: [3, 'En curso'],
    user_ids: [],
    user_id: false,
    timesheet_ids: [{ user_id: UID }],
    effective_hours: 4,
    create_date: '2026-08-29 09:00:00',
    write_date: '2026-08-29 18:00:00',
    active: true,
  },
  // Creada la más antigua de las tres, pero TOCADA hoy: con orden por
  // modificación se cuela la primera, con orden por creación no.
  {
    id: 2487,
    name: '08/28 Arreglos menores Solicitudes equipo',
    project_id: [12, 'DEV EQUIPO'],
    stage_id: [3, 'En curso'],
    user_ids: [],
    user_id: false,
    timesheet_ids: [{ user_id: UID }],
    effective_hours: 8,
    create_date: '2026-08-28 09:00:00',
    write_date: '2026-08-31 08:00:00',
    active: true,
  },
  // Archivada, con horas mías.
  {
    id: 2400,
    name: '08/01 Tarea vieja archivada',
    project_id: [18, 'Global Flow'],
    user_ids: [],
    user_id: false,
    timesheet_ids: [{ user_id: UID }],
    effective_hours: 2,
    create_date: '2026-08-01 09:00:00',
    write_date: '2026-08-01 10:00:00',
    active: false,
  },
  // Visible y asignada, pero su proyecto no admite hojas de horas.
  {
    id: 2410,
    name: '08/05 Tarea en proyecto sin timesheets',
    project_id: [24, 'Proyecto sin horas'],
    user_ids: [UID],
    user_id: [UID, 'Dev Test'],
    timesheet_ids: [{ user_id: UID }],
    effective_hours: 3,
    create_date: '2026-08-05 09:00:00',
    write_date: '2026-08-05 10:00:00',
    active: true,
  },
];

export const LINES = [
  { id: 1, task_id: [2488, TASKS[1].name], project_id: [12, 'DEV EQUIPO'], date: dayOffset(1), unit_amount: 4, user_id: UID },
  { id: 2, task_id: [2487, TASKS[2].name], project_id: [12, 'DEV EQUIPO'], date: dayOffset(2), unit_amount: 8, user_id: UID },
  { id: 3, task_id: [2400, TASKS[3].name], project_id: [18, 'Global Flow'], date: dayOffset(30), unit_amount: 2, user_id: UID },
  { id: 4, task_id: [2410, TASKS[4].name], project_id: [24, 'Proyecto sin horas'], date: dayOffset(25), unit_amount: 3, user_id: UID },
  // Fuera de la ventana por defecto del diagnóstico (60 días).
  { id: 5, task_id: [2300, 'Tarea antiquísima'], project_id: [18, 'Global Flow'], date: dayOffset(120), unit_amount: 5, user_id: UID },
  // De otra persona: nunca debe aparecer.
  { id: 6, task_id: [2488, TASKS[1].name], project_id: [12, 'DEV EQUIPO'], date: dayOffset(1), unit_amount: 9, user_id: 99 },
];

// --- Evaluación de dominios --------------------------------------------------

function resolve(field, record) {
  if (field.includes('.')) {
    const [relation, sub] = field.split('.');
    const related = record[relation] ?? [];
    return { value: related.map((row) => row[sub]), collection: true };
  }
  return { value: record[field], collection: false };
}

function matchLeaf(leaf, record) {
  const [field, operator, expected] = leaf;
  const { value, collection } = resolve(field, record);

  if (collection) {
    const wanted = Array.isArray(expected) ? expected : [expected];
    const hit = value.some((item) => wanted.includes(item));
    if (operator === '=' || operator === 'in') return hit;
    if (operator === '!=') return !hit;
    throw new Error(`operador no soportado sobre relación: ${operator}`);
  }

  // Many2one serializado como [id, nombre].
  const isMany2One = Array.isArray(value) && value.length === 2 && typeof value[1] === 'string';
  const scalar = isMany2One ? value[0] : value;

  switch (operator) {
    case '=':
      return scalar === expected;
    case '!=':
      return scalar !== expected;
    case 'in': {
      const wanted = Array.isArray(expected) ? expected : [expected];
      if (!isMany2One && Array.isArray(value)) {
        return value.some((item) => wanted.includes(item)); // x2many de ids
      }
      return wanted.includes(scalar);
    }
    case '>=':
      return String(scalar) >= String(expected);
    case '<=':
      return String(scalar) <= String(expected);
    case 'ilike':
      return String(scalar ?? '')
        .toLowerCase()
        .includes(String(expected).toLowerCase());
    default:
      throw new Error(`operador no soportado: ${operator}`);
  }
}

export function matchesDomain(domain, record) {
  let index = 0;
  const next = () => {
    const token = domain[index++];
    if (token === '&') {
      const left = next();
      const right = next();
      return left && right;
    }
    if (token === '|') {
      const left = next();
      const right = next();
      return left || right;
    }
    if (token === '!') {
      return !next();
    }
    return matchLeaf(token, record);
  };

  // Los términos de nivel superior se unen con AND implícito.
  let result = true;
  while (index < domain.length) {
    const value = next();
    result = result && value;
  }
  return result;
}

function sortRows(rows, order) {
  if (!order) return rows;
  const [field, direction = 'asc'] = order.split(/\s+/);
  return [...rows].sort((a, b) => {
    const left = String(a[field] ?? '');
    const right = String(b[field] ?? '');
    return direction === 'desc' ? right.localeCompare(left) : left.localeCompare(right);
  });
}

function project(rows, fields) {
  return rows.map((row) => {
    const picked = { id: row.id };
    for (const field of fields ?? []) {
      if (field in row) picked[field] = row[field];
    }
    return picked;
  });
}

// --- Servidor ----------------------------------------------------------------

export function createOdooServer() {
  /** Llamadas normalizadas a {model, method, params}, sea cual sea el transporte. */
  const received = [];
  /** Peticiones crudas, para comprobar la forma exacta del cable. */
  const wire = [];
  const state = { scenario: 'ok', tasks: [...TASKS], nextTaskId: 3000 };

  class Fault {
    constructor(status, name, message, debug) {
      Object.assign(this, { status, name, message, debug });
    }
  }

  function searchRead(rows, params) {
    const filtered = rows.filter((row) => matchesDomain(params.domain ?? [], row));
    const ordered = sortRows(filtered, params.order);
    const limited = params.limit ? ordered.slice(0, params.limit) : ordered;
    return project(limited, params.fields);
  }

  function dispatch(model, method, params) {
    received.push({ model, method, params });
    const { scenario } = state;

    if (scenario === 'odooerror') {
      throw new Fault(
        500,
        'odoo.exceptions.ValidationError',
        'Timesheets must be created with an active employee.',
        'Traceback (most recent call last): ...',
      );
    }
    if (scenario === 'accessdenied') {
      throw new Fault(401, 'odoo.exceptions.AccessDenied', 'Access Denied');
    }

    if (model === 'res.users' && method === 'context_get') {
      return { uid: UID, lang: 'es_MX', tz: 'America/Mexico_City' };
    }
    if (model === 'res.users' && method === 'read') {
      return [{ id: UID, login: 'dev@example.com', name: 'Dev Test' }];
    }
    if (model === 'ir.module.module' && method === 'search_read') {
      return [{ latest_version: '19.0.1.3' }];
    }

    if (model === 'project.task' && method === 'fields_get') {
      return scenario === 'legacy'
        ? { user_id: { type: 'many2one' }, stage_id: { type: 'many2one' } }
        : {
            user_ids: { type: 'many2many' },
            user_id: { type: 'many2one' },
            stage_id: { type: 'many2one' },
            timesheet_ids: { type: 'one2many' },
            effective_hours: { type: 'float' },
          };
    }
    if (model === 'project.project' && method === 'fields_get') {
      return scenario === 'legacy'
        ? { allow_timesheets: { type: 'boolean' } }
        : { allow_timesheets: { type: 'boolean' }, task_count: { type: 'integer' } };
    }

    if (model === 'project.task' && method === 'search_read') {
      // active_test:false es lo que hace que search incluya archivados.
      const includeArchived = params.context?.active_test === false;
      const pool = includeArchived ? state.tasks : state.tasks.filter((task) => task.active);
      return searchRead(pool, params);
    }
    if (model === 'project.task' && method === 'create') {
      const created = params.vals_list.map((values) => {
        const projectId = values.project_id;
        const found = PROJECTS.find((entry) => entry.id === projectId);
        const assignees = values.user_ids ? values.user_ids[0][2] : [];
        const task = {
          id: state.nextTaskId++,
          name: values.name,
          project_id: found ? [found.id, found.name] : false,
          stage_id: [1, 'Nuevo'],
          user_ids: values.user_ids ? assignees : [],
          user_id: values.user_id ? [values.user_id, 'Dev Test'] : false,
          timesheet_ids: [],
          effective_hours: 0,
          create_date: '2026-08-31 12:00:00',
          write_date: '2026-08-31 12:00:00',
          active: true,
        };
        state.tasks.push(task);
        return task.id;
      });
      return created;
    }

    if (model === 'project.project' && method === 'search_read') {
      return searchRead(PROJECTS, params);
    }

    if (model === 'account.analytic.line' && method === 'search_read') {
      return searchRead(LINES, params);
    }
    if (model === 'account.analytic.line' && method === 'create') {
      return scenario === 'single-id'
        ? 501
        : params.vals_list.map((_, index) => 500 + index);
    }

    if (model === 'hr.employee' && method === 'search_read') {
      if (scenario === 'noemployee') return [];
      if (scenario === 'employee-restricted') {
        throw new Fault(403, 'odoo.exceptions.AccessError', 'Sin acceso a hr.employee');
      }
      return [{ id: 33, name: 'Dev Test' }];
    }
    if (model === 'hr.employee.public' && method === 'search_read') {
      return [{ id: 33, name: 'Dev Test' }];
    }
    return [];
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      wire.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });

      if (state.scenario === 'html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><html>login page</html>');
        return;
      }

      // ---- JSON-2 ---------------------------------------------------------
      if (req.url.startsWith('/json/2/')) {
        if (state.scenario === 'no-json2') {
          res.writeHead(404, { 'Content-Type': 'text/html' }).end('<html>Not Found</html>');
          return;
        }
        if (state.scenario === 'bad-apikey') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ name: 'werkzeug.exceptions.Unauthorized', message: 'Invalid apikey' }));
          return;
        }

        const [, , , model, method] = req.url.split('/');
        try {
          const result = dispatch(model, method, JSON.parse(raw));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (fault) {
          res.writeHead(fault.status ?? 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ name: fault.name, message: fault.message, debug: fault.debug }));
        }
        return;
      }

      // ---- JSON-RPC -------------------------------------------------------
      if (req.url !== '/jsonrpc') {
        res.writeHead(404).end();
        return;
      }
      if (state.scenario === '404') {
        res.writeHead(404, { 'Content-Type': 'text/html' }).end('<html>Not Found</html>');
        return;
      }

      const body = JSON.parse(raw);
      const { service, method, args } = body.params;
      const reply = (payload) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...payload }));
      };

      if (service === 'common' && method === 'version') {
        return reply({ result: { server_version: '18.0+e' } });
      }
      if (service === 'common' && method === 'authenticate') {
        return reply({ result: state.scenario === 'badpass' ? false : UID });
      }
      if (service === 'db' && method === 'list') {
        return reply({ result: ['produccion', 'staging'] });
      }
      if (service === 'object' && method === 'execute_kw') {
        const [, , , model, modelMethod, positional, kwargs] = args;
        // Traduce los argumentos posicionales al mismo objeto nombrado que usa
        // JSON-2, para que la lógica del servidor sea una sola.
        const params = { ...kwargs };
        if (modelMethod === 'search_read') {
          params.domain = positional[0];
        } else if (modelMethod === 'fields_get') {
          params.allfields = positional[0];
          params.attributes = positional[1];
        } else if (modelMethod === 'create') {
          params.vals_list = positional[0];
        } else if (modelMethod === 'read') {
          params.ids = positional[0];
        }
        try {
          return reply({ result: dispatch(model, modelMethod, params) });
        } catch (fault) {
          return reply({
            error: {
              code: 200,
              message: 'Odoo Server Error',
              data: { name: fault.name, message: fault.message, debug: fault.debug },
            },
          });
        }
      }
      return reply({ result: null });
    });
  });

  return {
    server,
    received,
    wire,
    lastCall: () => received[received.length - 1],
    lastWire: () => wire[wire.length - 1],
    setScenario: (value) => {
      state.scenario = value;
    },
    resetTasks: () => {
      state.tasks = [...TASKS];
    },
    findTask: (id) => state.tasks.find((task) => task.id === id),
  };
}
