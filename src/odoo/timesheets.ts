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
  const uid = client.userId;
  if (uid === undefined) {
    throw new OdooError('No hay una sesión activa de Odoo.', 'auth');
  }

  const domain = [['user_id', '=', uid]];

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
