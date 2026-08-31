import type { OdooClient } from './client';

/**
 * Diferencias de esquema entre versiones de Odoo que sí nos afectan.
 *
 * En vez de parsear el número de versión (que además miente en instancias
 * personalizadas) se le pregunta al propio servidor con `fields_get`. Así el
 * mismo código sirve de Odoo 15 a 19 sin ramificar por versión.
 */
export interface OdooSchema {
  serverVersion: string;
  majorVersion: number;
  api: 'json2' | 'jsonrpc';
  /** `user_ids` (Many2many, Odoo 16+) o `user_id` (Many2one, Odoo ≤ 15). */
  assigneeField: 'user_ids' | 'user_id';
  hasStage: boolean;
  /** One2many a account.antalytic.line que añade hr_timesheet a project.task. */
  hasTimesheetIds: boolean;
  /** `effective_hours` («Time Spent»), calculado y almacenado. */
  hasEffectiveHours: boolean;
  /** `allow_timesheets` lo añade el módulo hr_timesheet a project.project. */
  hasAllowTimesheets: boolean;
  /** Campo calculado no almacenado: solo se pide si existe. */
  hasTaskCount: boolean;
}

export async function detectSchema(
  client: OdooClient,
  log: (message: string) => void,
): Promise<OdooSchema> {
  let assigneeField: OdooSchema['assigneeField'] = 'user_ids';
  let hasStage = true;
  let hasTimesheetIds = true;
  let hasEffectiveHours = true;
  let hasAllowTimesheets = true;
  let hasTaskCount = true;

  try {
    const taskFields = await client.fieldsGet('project.task', [
      'user_ids',
      'user_id',
      'stage_id',
      'timesheet_ids',
      'effective_hours',
    ]);
    if (!taskFields.user_ids && taskFields.user_id) {
      assigneeField = 'user_id';
    }
    hasStage = Boolean(taskFields.stage_id);
    hasTimesheetIds = Boolean(taskFields.timesheet_ids);
    hasEffectiveHours = Boolean(taskFields.effective_hours);
  } catch (error) {
    // Si el módulo de proyectos no está instalado o no hay permisos de lectura,
    // seguimos con los valores por defecto y que falle más tarde con un mensaje
    // concreto de la operación que el usuario pidió.
    log(`No se pudo inspeccionar project.task: ${describe(error)}`);
  }

  try {
    const projectFields = await client.fieldsGet('project.project', [
      'allow_timesheets',
      'task_count',
    ]);
    hasAllowTimesheets = Boolean(projectFields.allow_timesheets);
    hasTaskCount = Boolean(projectFields.task_count);
  } catch (error) {
    log(`No se pudo inspeccionar project.project: ${describe(error)}`);
  }

  return {
    serverVersion: client.serverVersion,
    majorVersion: client.majorVersion,
    api: client.api,
    assigneeField,
    hasStage,
    hasTimesheetIds,
    hasEffectiveHours,
    hasAllowTimesheets,
    hasTaskCount,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
