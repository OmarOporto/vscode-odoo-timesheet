import type { TimesheetRow } from '../hours';
import { OdooError, type OdooClient } from './client';

export interface TimesheetLineInput {
  /** `YYYY-MM-DD` */
  date: string;
  description: string;
  /** Horas decimales. Odoo almacena `unit_amount` siempre en horas. */
  hours: number;
  taskId: number;
  projectId: number;
}

/**
 * `account.analytic.line.create()` exige un empleado: si no se lo pasas, Odoo
 * intenta deducirlo de `user_id` y, si no puede, lanza un ValidationError poco
 * claro. Lo resolvemos antes para dar un mensaje accionable.
 */
export async function resolveEmployeeId(client: OdooClient): Promise<number> {
  const domain = [['user_id', '=', client.userId]];

  try {
    const employees = await client.searchRead<{ id: number }>('hr.employee', domain, ['name'], {
      limit: 1,
    });
    if (employees.length > 0) {
      return employees[0].id;
    }
  } catch (error) {
    // Algunos perfiles no tienen lectura sobre hr.employee pero sí sobre la
    // vista pública, que comparte la misma tabla y por tanto los mismos ids.
    const publicEmployees = await client.searchRead<{ id: number }>(
      'hr.employee.public',
      domain,
      ['name'],
      { limit: 1 },
    );
    if (publicEmployees.length > 0) {
      return publicEmployees[0].id;
    }
    throw error;
  }

  throw new OdooError(
    'Tu usuario de Odoo no tiene un empleado asociado, y las hojas de horas lo exigen. Pide a un administrador que cree tu ficha en Empleados y la vincule a tu usuario.',
    'server',
  );
}

export async function createTimesheetLines(
  client: OdooClient,
  employeeId: number,
  lines: TimesheetLineInput[],
): Promise<number[]> {
  const values = lines.map((line) => ({
    date: line.date,
    name: line.description,
    unit_amount: line.hours,
    task_id: line.taskId,
    project_id: line.projectId,
    employee_id: employeeId,
  }));
  return client.create('account.analytic.line', values);
}

/** Los campos mínimos: la vista solo muestra totales, no líneas sueltas. */
export const HOURS_FIELDS = ['date', 'unit_amount'];

/**
 * Dominio de «mis horas en este rango».
 *
 * - `project_id != false` es como el propio hr_timesheet define «esto es una
 *   hoja de horas»: `account.analytic.line` es la tabla analítica general y
 *   guarda también apuntes de facturas, compras y gastos, que inflarían el
 *   total en silencio.
 * - **No** se filtra `task_id != false`, a diferencia del diagnóstico: imputar
 *   al proyecto sin tarea es legítimo y frecuente, y esas horas cuentan.
 * - `user_id` y no `employee_id`: es un related almacenado de
 *   `employee_id.user_id`, así que la vista funciona aunque el usuario no tenga
 *   ficha de empleado. Es una asimetría deliberada con el camino de escritura,
 *   que sí la exige (ver `resolveEmployeeId`): leer tus horas no debería
 *   requerir lo que hace falta para crearlas.
 */
export function hoursDomain(userId: number, from: string, to: string): unknown[] {
  return [
    ['user_id', '=', userId],
    ['project_id', '!=', false],
    ['date', '>=', from],
    ['date', '<=', to],
  ];
}

export async function fetchTimesheetLines(
  client: OdooClient,
  from: string,
  to: string,
  limit: number,
): Promise<TimesheetRow[]> {
  return client.searchRead<TimesheetRow>(
    'account.analytic.line',
    hoursDomain(client.userId, from, to),
    HOURS_FIELDS,
    // Un solo término de orden a propósito: el servidor simulado de los tests
    // parte el `order` por espacios y `'date desc, id asc'` lo dejaría mudo.
    { order: 'date asc', limit },
  );
}
