import type { OdooClient } from './client';
import type { OdooSchema } from './schema';
import { daysAgo } from '../util';
import { orderClause, scopeDomain, type Many2One, type TaskOrder, type TaskScope } from './tasks';

/**
 * Responde a «¿por qué esta tarea no aparece en el panel?».
 *
 * La investigación va al revés que la consulta normal: parte de las
 * imputaciones reales del usuario en `account.analytic.line` —que por
 * definición son las tareas que debería estar viendo— y descarta causas en
 * orden hasta encontrar cuál la oculta.
 */

export interface TaskDiagnosis {
  taskId: number;
  taskName: string;
  projectId?: number;
  projectName?: string;
  loggedHours: number;
  /** Fecha de la imputación más reciente, `YYYY-MM-DD`. */
  lastDate: string;
  visible: boolean;
  reasons: string[];
}

export interface DiagnosticsReport {
  scope: TaskScope;
  order: TaskOrder;
  daysBack: number;
  tasksPerProject: number;
  since: string;
  linesFound: number;
  tasks: TaskDiagnosis[];
  suggestions: string[];
}

export interface DiagnoseOptions {
  scope: TaskScope;
  order: TaskOrder;
  daysBack: number;
  /** Lo que el árbol muestra por proyecto antes de «Mostrar más». */
  tasksPerProject: number;
}

interface TimesheetRow {
  id: number;
  task_id: Many2One;
  project_id: Many2One;
  date: string;
  unit_amount: number;
}

interface TaskRow {
  id: number;
  name: string;
  project_id: Many2One;
  user_ids?: number[];
  user_id?: Many2One;
}

interface ProjectRow {
  id: number;
  name: string;
  allow_timesheets?: boolean;
}

interface Aggregated {
  taskId: number;
  taskName: string;
  projectId?: number;
  projectName?: string;
  hours: number;
  lastDate: string;
}

export async function diagnoseMissingTasks(
  client: OdooClient,
  schema: OdooSchema,
  options: DiagnoseOptions,
): Promise<DiagnosticsReport> {
  const since = daysAgo(options.daysBack);

  // 1. Punto de partida: dónde ha imputado horas realmente el usuario.
  const lines = await client.searchRead<TimesheetRow>(
    'account.analytic.line',
    [
      ['user_id', '=', client.userId],
      ['date', '>=', since],
      ['task_id', '!=', false],
    ],
    ['task_id', 'project_id', 'date', 'unit_amount'],
    { order: 'date desc', limit: 500 },
  );

  const aggregated = aggregate(lines);
  const report: DiagnosticsReport = {
    scope: options.scope,
    order: options.order,
    daysBack: options.daysBack,
    tasksPerProject: options.tasksPerProject,
    since,
    linesFound: lines.length,
    tasks: [],
    suggestions: [],
  };

  if (aggregated.length === 0) {
    report.suggestions.push(
      `No hay imputaciones tuyas con tarea desde ${since}. Si esperabas encontrarlas, revisa que tu usuario de Odoo sea el mismo con el que registras horas, o amplía odooTimesheet.diagnosticsDays.`,
    );
    return report;
  }

  const taskIds = aggregated.map((entry) => entry.taskId);

  // 2. ¿Existen y son visibles para este usuario?
  const assigneeField = schema.assigneeField;
  const visibleTasks = await client.searchRead<TaskRow>(
    'project.task',
    [['id', 'in', taskIds]],
    ['name', 'project_id', assigneeField],
    { limit: taskIds.length },
  );
  const visibleById = new Map(visibleTasks.map((task) => [task.id, task]));

  const notVisible = taskIds.filter((id) => !visibleById.has(id));
  const archived = new Set<number>();
  if (notVisible.length > 0) {
    // active_test:false hace que search incluya los registros archivados.
    const withArchived = await client.searchRead<{ id: number }>(
      'project.task',
      [['id', 'in', notVisible]],
      ['name'],
      { limit: notVisible.length, context: { active_test: false } },
    );
    for (const task of withArchived) {
      archived.add(task.id);
    }
  }

  // 3. ¿Las deja pasar el filtro configurado?
  const visibleIds = [...visibleById.keys()];
  const scopedIds = new Set<number>();
  if (visibleIds.length > 0) {
    const scoped = await client.searchRead<{ id: number }>(
      'project.task',
      [['id', 'in', visibleIds], ...scopeDomain(client, schema, options.scope)],
      ['name'],
      { limit: visibleIds.length },
    );
    for (const task of scoped) {
      scopedIds.add(task.id);
    }
  }

  // 4. ¿Se listan sus proyectos en el árbol?
  const projectIds = [...new Set(aggregated.map((entry) => entry.projectId).filter(isNumber))];
  const projectFields = schema.hasAllowTimesheets ? ['name', 'allow_timesheets'] : ['name'];
  const projects =
    projectIds.length > 0
      ? await client.searchRead<ProjectRow>('project.project', [['id', 'in', projectIds]], projectFields, {
          limit: projectIds.length,
        })
      : [];
  const projectById = new Map(projects.map((project) => [project.id, project]));

  // 5. ¿Caben en la página que el árbol muestra por proyecto?
  const shownPerProject = new Map<number, Set<number>>();
  for (const projectId of projectIds) {
    const shown = await client.searchRead<{ id: number }>(
      'project.task',
      [['project_id', '=', projectId], ...scopeDomain(client, schema, options.scope)],
      ['name'],
      { limit: options.tasksPerProject, order: orderClause(options.order) },
    );
    shownPerProject.set(projectId, new Set(shown.map((task) => task.id)));
  }

  for (const entry of aggregated) {
    const reasons: string[] = [];
    const task = visibleById.get(entry.taskId);

    if (!task) {
      reasons.push(
        archived.has(entry.taskId)
          ? 'la tarea está archivada en Odoo (active = false), y las búsquedas no devuelven archivados'
          : 'no tienes acceso a la tarea: una regla de registro o una compañía distinta la esconde',
      );
    } else {
      if (!scopedIds.has(entry.taskId)) {
        reasons.push(
          `el filtro odooTimesheet.taskScope = "${options.scope}" la excluye${
            describeAssignees(task, assigneeField, client.userId) ?? ''
          }`,
        );
      }

      const project = entry.projectId !== undefined ? projectById.get(entry.projectId) : undefined;
      if (entry.projectId !== undefined && !project) {
        reasons.push('no puedes ver el proyecto al que pertenece, así que no aparece en el árbol');
      } else if (project && schema.hasAllowTimesheets && project.allow_timesheets === false) {
        reasons.push(
          `el proyecto «${project.name}» tiene las hojas de horas desactivadas (allow_timesheets = false) y el panel no lo lista`,
        );
      }

      if (
        scopedIds.has(entry.taskId) &&
        entry.projectId !== undefined &&
        shownPerProject.get(entry.projectId)?.has(entry.taskId) === false
      ) {
        reasons.push(
          `queda fuera de las ${options.tasksPerProject} tareas que el panel muestra por proyecto (odooTimesheet.tasksPerProject); ábrela con «Mostrar más»`,
        );
      }
    }

    report.tasks.push({
      taskId: entry.taskId,
      taskName: entry.taskName,
      projectId: entry.projectId,
      projectName: entry.projectName,
      loggedHours: entry.hours,
      lastDate: entry.lastDate,
      visible: reasons.length === 0,
      reasons,
    });
  }

  report.suggestions = buildSuggestions(report, options, schema);
  return report;
}

function aggregate(lines: TimesheetRow[]): Aggregated[] {
  const byTask = new Map<number, Aggregated>();

  for (const line of lines) {
    if (!Array.isArray(line.task_id)) {
      continue;
    }
    const [taskId, taskName] = line.task_id;
    const existing = byTask.get(taskId);
    if (existing) {
      existing.hours += line.unit_amount ?? 0;
      if (line.date > existing.lastDate) {
        existing.lastDate = line.date;
      }
      continue;
    }
    byTask.set(taskId, {
      taskId,
      taskName,
      projectId: Array.isArray(line.project_id) ? line.project_id[0] : undefined,
      projectName: Array.isArray(line.project_id) ? line.project_id[1] : undefined,
      hours: line.unit_amount ?? 0,
      lastDate: line.date,
    });
  }

  return [...byTask.values()].sort((a, b) => b.lastDate.localeCompare(a.lastDate));
}

/** Precisa el motivo cuando el filtro es de asignación, que es el caso habitual. */
function describeAssignees(
  task: TaskRow,
  assigneeField: 'user_ids' | 'user_id',
  uid: number,
): string | undefined {
  if (assigneeField === 'user_ids') {
    const assignees = Array.isArray(task.user_ids) ? task.user_ids : [];
    if (assignees.length === 0) {
      return ': la tarea no tiene a nadie en Asignados, y registrar horas no te asigna a ella';
    }
    if (!assignees.includes(uid)) {
      return ': no estás entre sus Asignados';
    }
    return undefined;
  }
  const assignee = Array.isArray(task.user_id) ? task.user_id[0] : undefined;
  return assignee === uid ? undefined : ': no eres el usuario asignado';
}

function buildSuggestions(
  report: DiagnosticsReport,
  options: DiagnoseOptions,
  schema: OdooSchema,
): string[] {
  const suggestions: string[] = [];
  const hidden = report.tasks.filter((task) => !task.visible);
  if (hidden.length === 0) {
    suggestions.push('Todas las tareas con horas tuyas son visibles en el panel.');
    return suggestions;
  }

  const has = (fragment: string): boolean =>
    hidden.some((task) => task.reasons.some((reason) => reason.includes(fragment)));

  if (has('taskScope') && options.scope !== 'mine' && schema.hasTimesheetIds) {
    suggestions.push(
      'Pon "odooTimesheet.taskScope": "mine" en tu settings.json: trae las tareas asignadas a ti Y aquellas en las que ya has registrado horas.',
    );
  } else if (has('taskScope')) {
    suggestions.push(
      'Prueba con "odooTimesheet.taskScope": "all" para ver todas las tareas visibles del proyecto.',
    );
  }
  if (has('archivada')) {
    suggestions.push('Hay tareas archivadas en Odoo: desarchívalas si quieres seguir imputando en ellas.');
  }
  if (has('allow_timesheets')) {
    suggestions.push(
      'Activa las hojas de horas en la configuración del proyecto en Odoo para que el panel lo liste.',
    );
  }
  if (has('tasksPerProject')) {
    suggestions.push(
      `Usa «Mostrar más» en el proyecto, o sube "odooTimesheet.tasksPerProject" por encima de ${options.tasksPerProject}.`,
    );
  }
  if (has('regla de registro')) {
    suggestions.push(
      'Alguna tarea pertenece a un proyecto o compañía a la que tu usuario no tiene acceso: pídelo en Odoo.',
    );
  }
  return suggestions;
}

function isNumber(value: number | undefined): value is number {
  return value !== undefined;
}
