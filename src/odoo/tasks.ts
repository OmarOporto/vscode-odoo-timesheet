import { OdooError, type OdooClient } from './client';
import type { OdooSchema } from './schema';

/** Los Many2one llegan como `[id, nombre]`, o `false` si están vacíos. */
export type Many2One = [number, string] | false;

export interface OdooTask {
  id: number;
  name: string;
  project_id: Many2One;
  stage_id?: Many2One;
  effective_hours?: number;
  write_date: string;
}

export interface OdooProject {
  id: number;
  name: string;
  task_count?: number;
}

/**
 * Qué tareas trae el panel.
 *
 * `mine` es el valor correcto para una extensión de hojas de horas: imputar
 * horas a una tarea **no** te convierte en asignado de ella, así que filtrar
 * solo por `user_ids` esconde justo las tareas en las que trabajas a diario.
 */
export type TaskScope = 'mine' | 'assigned' | 'timesheet' | 'all';

/**
 * Se ordena por fecha de **creación** por defecto: con `write_date`, tocar una
 * tarea vieja la subía al principio, que es justo lo contrario de lo que quieres
 * cuando creas una tarea por día. `create_date` es campo mágico de todos los
 * modelos de Odoo, así que no hace falta comprobarlo con `fields_get`.
 */
export type TaskOrder = 'created' | 'updated' | 'name';

export function orderClause(order: TaskOrder = 'created'): string {
  switch (order) {
    case 'updated':
      return 'write_date desc';
    case 'name':
      return 'name asc';
    case 'created':
    default:
      return 'create_date desc';
  }
}

export interface TaskQuery {
  query?: string;
  scope: TaskScope;
  limit: number;
  projectId?: number;
  order?: TaskOrder;
}

export function taskFields(schema: OdooSchema): string[] {
  const fields = ['name', 'project_id', 'write_date'];
  if (schema.hasStage) {
    fields.push('stage_id');
  }
  if (schema.hasEffectiveHours) {
    fields.push('effective_hours');
  }
  return fields;
}

/**
 * Términos de dominio que acotan las tareas al usuario actual. Se devuelve como
 * lista para poder componerla con otros filtros: Odoo une con AND implícito lo
 * que no lleve operador delante.
 */
export function scopeDomain(
  client: OdooClient,
  schema: OdooSchema,
  scope: TaskScope,
): unknown[] {
  const uid = client.userId;
  const assigned = [schema.assigneeField, 'in', [uid]];
  const timesheet = ['timesheet_ids.user_id', '=', uid];

  switch (scope) {
    case 'all':
      return [];
    case 'assigned':
      return [assigned];
    case 'timesheet':
      // Sin hr_timesheet no existe timesheet_ids: mejor degradar que reventar.
      return schema.hasTimesheetIds ? [timesheet] : [assigned];
    case 'mine':
    default:
      return schema.hasTimesheetIds ? ['|', assigned, timesheet] : [assigned];
  }
}

export async function searchTasks(
  client: OdooClient,
  schema: OdooSchema,
  query: TaskQuery,
): Promise<OdooTask[]> {
  const domain: unknown[] = [];

  if (query.projectId !== undefined) {
    domain.push(['project_id', '=', query.projectId]);
  }
  domain.push(...scopeDomain(client, schema, query.scope));

  const text = query.query?.trim();
  if (text) {
    if (/^\d+$/.test(text)) {
      // Prefijo polaco: el `|` afecta a los dos términos siguientes, y el resto
      // de la lista sigue unido por AND implícito.
      domain.push('|', ['id', '=', Number(text)], ['name', 'ilike', text]);
    } else {
      domain.push(['name', 'ilike', text]);
    }
  }

  return client.searchRead<OdooTask>('project.task', domain, taskFields(schema), {
    limit: query.limit,
    order: orderClause(query.order),
  });
}

export async function listProjects(
  client: OdooClient,
  schema: OdooSchema,
  options: { limit: number; query?: string } = { limit: 200 },
): Promise<OdooProject[]> {
  const domain: unknown[] = [];
  if (schema.hasAllowTimesheets) {
    // Un proyecto sin hojas de horas no puede recibir líneas: sobra en la lista.
    domain.push(['allow_timesheets', '=', true]);
  }
  const text = options.query?.trim();
  if (text) {
    domain.push(['name', 'ilike', text]);
  }

  const fields = schema.hasTaskCount ? ['name', 'task_count'] : ['name'];
  return client.searchRead<OdooProject>('project.project', domain, fields, {
    limit: options.limit,
    order: 'name asc',
  });
}

export interface NewTask {
  name: string;
  projectId: number;
  assignToMe: boolean;
}

/**
 * Crea una tarea y la devuelve ya releída, para que el resto del flujo tenga
 * los mismos campos que si viniera de una búsqueda.
 *
 * Autoasignarse evita de raíz que la tarea quede invisible para el panel: una
 * tarea creada al vuelo desde la rejilla de Odoo nace sin asignados.
 */
export async function createTask(
  client: OdooClient,
  schema: OdooSchema,
  task: NewTask,
): Promise<OdooTask> {
  const values: Record<string, unknown> = {
    name: task.name,
    project_id: task.projectId,
  };
  if (task.assignToMe) {
    values[schema.assigneeField] =
      schema.assigneeField === 'user_ids'
        ? // Comando x2many de Odoo: (6, 0, ids) reemplaza el conjunto entero.
          [[6, 0, [client.userId]]]
        : client.userId;
  }

  const ids = await client.create('project.task', [values]);
  const id = ids[0];
  if (id === undefined) {
    throw new OdooError('Odoo no devolvió el id de la tarea creada.', 'server');
  }

  const [created] = await client.searchRead<OdooTask>(
    'project.task',
    [['id', '=', id]],
    taskFields(schema),
    { limit: 1 },
  );
  if (!created) {
    throw new OdooError(
      `La tarea se creó (id ${id}) pero no se pudo volver a leer. Revísala en Odoo.`,
      'server',
    );
  }
  return created;
}

export function projectOf(task: OdooTask): { id: number; name: string } | undefined {
  return Array.isArray(task.project_id)
    ? { id: task.project_id[0], name: task.project_id[1] }
    : undefined;
}

export function stageOf(task: OdooTask): string | undefined {
  return Array.isArray(task.stage_id) ? task.stage_id[1] : undefined;
}

/**
 * Odoo 17 estrenó el enrutador por rutas: `/odoo/<modelo>/<id>` funciona porque
 * el nombre del modelo lleva un punto, que es como el router distingue un modelo
 * de una acción. En versiones anteriores hay que usar el hash del cliente viejo.
 */
export function recordUrl(
  baseUrl: string,
  majorVersion: number,
  model: string,
  id: number,
): string {
  return majorVersion >= 17
    ? `${baseUrl}/odoo/${model}/${id}`
    : `${baseUrl}/web#id=${id}&model=${model}&view_type=form`;
}
