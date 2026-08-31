import type { OdooClient } from './client';
import type { OdooSchema } from './schema';

/** Los Many2one llegan por RPC como `[id, nombre]`, o `false` si están vacíos. */
export type Many2One = [number, string] | false;

export interface OdooTask {
  id: number;
  name: string;
  project_id: Many2One;
  stage_id?: Many2One;
  write_date: string;
}

export type TaskScope = 'assigned' | 'all';

export interface TaskQuery {
  query?: string;
  scope: TaskScope;
  limit: number;
}

const TASK_FIELDS = ['name', 'project_id', 'stage_id', 'write_date'];

export async function searchTasks(
  client: OdooClient,
  schema: OdooSchema,
  query: TaskQuery,
): Promise<OdooTask[]> {
  const domain: unknown[] = [];

  if (query.scope === 'assigned' && client.userId !== undefined) {
    // `in` funciona igual para el Many2many de 16+ y para el Many2one antiguo.
    domain.push([schema.assigneeField, 'in', [client.userId]]);
  }

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

  const fields = schema.hasStage ? TASK_FIELDS : TASK_FIELDS.filter((field) => field !== 'stage_id');

  return client.searchRead<OdooTask>('project.task', domain, fields, {
    limit: query.limit,
    order: 'write_date desc',
  });
}

export function projectOf(task: OdooTask): { id: number; name: string } | undefined {
  return Array.isArray(task.project_id)
    ? { id: task.project_id[0], name: task.project_id[1] }
    : undefined;
}

export function stageOf(task: OdooTask): string | undefined {
  return Array.isArray(task.stage_id) ? task.stage_id[1] : undefined;
}

/** URL de formulario que funciona tanto en el cliente web viejo como en el de Odoo 17+. */
export function recordUrl(baseUrl: string, model: string, id: number): string {
  return `${baseUrl}/web#id=${id}&model=${model}&view_type=form`;
}
