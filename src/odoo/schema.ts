import type { OdooClient } from './client';

/**
 * Diferencias de esquema entre versiones de Odoo que sí nos afectan.
 *
 * En vez de parsear el número de versión (que además miente en instancias
 * personalizadas) se le pregunta al propio servidor con `fields_get`. Así el
 * mismo código sirve de Odoo 15 a 18 sin ramificar por versión.
 */
export interface OdooSchema {
  serverVersion: string;
  /** `user_ids` (Many2many, Odoo 16+) o `user_id` (Many2one, Odoo ≤ 15). */
  assigneeField: 'user_ids' | 'user_id';
  hasStage: boolean;
}

interface FieldDescription {
  type?: string;
  string?: string;
}

export async function detectSchema(
  client: OdooClient,
  log: (message: string) => void,
): Promise<OdooSchema> {
  const serverVersion = await client.version();

  let assigneeField: OdooSchema['assigneeField'] = 'user_ids';
  let hasStage = true;

  try {
    const fields = await client.execute<Record<string, FieldDescription>>(
      'project.task',
      'fields_get',
      [['user_ids', 'user_id', 'stage_id'], ['type']],
    );
    if (!fields.user_ids && fields.user_id) {
      assigneeField = 'user_id';
    }
    hasStage = Boolean(fields.stage_id);
  } catch (error) {
    // Si el módulo de proyectos no está instalado o no hay permisos de lectura
    // sobre el modelo, seguimos con los valores por defecto y que falle más
    // tarde con un mensaje concreto de la operación que el usuario pidió.
    log(`No se pudo inspeccionar project.task: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { serverVersion, assigneeField, hasStage };
}
