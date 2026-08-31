import * as vscode from 'vscode';
import { groupByDay } from '../git/gitService';
import type { Commit } from '../git/types';
import {
  createTask,
  projectOf,
  recordUrl,
  searchTasks,
  stageOf,
  type OdooTask,
  type TaskOrder,
  type TaskScope,
} from '../odoo/tasks';
import { planLines, type LineDate, type LineDraft, type LineMode } from '../lines';
import { createTimesheetLines, type TimesheetLineInput } from '../odoo/timesheets';
import { readPinnedProject, type OdooSession } from '../state';
import {
  formatDayLabel,
  formatHours,
  formatTaskDate,
  joinCommitText,
  parseHours,
  parseIsoDay,
  pluralize,
  todayLocalDay,
  truncate,
} from '../util';
import { CommitNode, DayNode, type CommitsTreeProvider } from '../views/commitsTree';
import { ProjectNode, TaskNode, type TasksTreeProvider } from '../views/tasksTree';
import { pickProject } from './projects';

export interface LogTimeDeps {
  session: OdooSession;
  commits: CommitsTreeProvider;
  tasks: TasksTreeProvider;
  log: vscode.LogOutputChannel;
}

/**
 * Tope de la descripción sugerida. Odoo no impone ninguno, pero la rejilla de
 * hojas de horas muestra la descripción en una celda de una línea. Es solo el
 * valor precargado: si escribes más en el InputBox, se guarda entero.
 */
const MAX_DESCRIPTION = 1000;

export async function logTimeCommand(deps: LogTimeDeps, node?: unknown): Promise<void> {
  try {
    await run(deps, node);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log.error(`No se pudieron registrar las horas: ${message}`);
    void vscode.window.showErrorMessage(message, 'Ver registro').then((action) => {
      if (action) {
        deps.log.show();
      }
    });
  }
}

async function run(deps: LogTimeDeps, node?: unknown): Promise<void> {
  const { session } = deps;

  if (!session.isConnected) {
    const action = await vscode.window.showWarningMessage(
      'Necesitas conectarte a Odoo para registrar horas.',
      'Conectar a Odoo',
    );
    if (action !== 'Conectar a Odoo') {
      return;
    }
    await vscode.commands.executeCommand('odooTimesheet.connect');
    if (!session.isConnected) {
      return;
    }
  }

  // El comando entra desde cuatro sitios distintos del árbol; cada uno precarga
  // una parte del flujo.
  let preselected: Commit[] = [];
  let presetTask: OdooTask | undefined;
  let projectId: number | undefined;

  if (node instanceof DayNode) {
    preselected = node.commits;
  } else if (node instanceof CommitNode) {
    preselected = [node.commit];
  } else if (node instanceof TaskNode) {
    presetTask = node.task;
  } else if (node instanceof ProjectNode) {
    projectId = node.project.id;
  }

  // Con un proyecto fijado en el panel, el paso de proyecto sobra: fijarlo es
  // precisamente para no volver a elegirlo.
  if (projectId === undefined && !presetTask) {
    projectId = readPinnedProject()?.id;
  }

  const available = await deps.commits.getCommits();
  if (available.length === 0) {
    void vscode.window.showWarningMessage(
      'No hay commits en el rango configurado. Amplía «odooTimesheet.daysBack» o desactiva el filtro por autor.',
    );
    return;
  }

  const selected = await pickCommits(available, preselected);
  if (!selected || selected.length === 0) {
    return;
  }

  // La fecha se decide aquí, antes que la tarea, porque el nombre que se propone
  // para una tarea nueva lleva su prefijo: proponer «08/29 …» para imputarlo el
  // 31 contradiría la convención de una tarea por día.
  const lineDate = await resolveLineDate(selected);
  if (!lineDate) {
    return;
  }
  const nameDay =
    lineDate.kind === 'fixed' ? lineDate.day : (groupByDay(selected)[0]?.day ?? todayLocalDay());

  if (!presetTask && projectId === undefined) {
    const choice = await pickProject(session, {
      title: 'Proyecto de la tarea',
      includeAll: true,
    });
    if (!choice) {
      return;
    }
    projectId = choice.id;
  }

  const suggestedName = suggestTaskName(selected, nameDay);
  const picked = presetTask
    ? { kind: 'existing' as const, task: presetTask }
    : await pickTask(deps, projectId, suggestedName);
  if (!picked) {
    return;
  }

  const task =
    picked.kind === 'existing'
      ? picked.task
      : await createTaskInteractively(deps, picked.typed || suggestedName, projectId);
  if (!task) {
    return;
  }

  const project = projectOf(task);
  if (!project) {
    void vscode.window.showErrorMessage(
      `La tarea «${task.name}» no pertenece a ningún proyecto, así que Odoo no admite horas sobre ella.`,
    );
    return;
  }

  const mode = await pickMode(selected.length);
  if (!mode) {
    return;
  }

  const lines = await buildLines(planLines(selected, lineDate, mode), mode, task.id, project.id);
  if (!lines || lines.length === 0) {
    return;
  }

  const { client } = session.requireConnection();
  const employeeId = await session.getEmployeeId();

  const ids = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Registrando horas en Odoo…' },
    () => createTimesheetLines(client, employeeId, lines),
  );

  const totalHours = lines.reduce((sum, line) => sum + line.hours, 0);
  deps.log.info(
    `Creadas ${ids.length} líneas (${formatHours(totalHours)}) en la tarea #${task.id} «${task.name}»`,
  );
  deps.tasks.refresh();

  const action = await vscode.window.showInformationMessage(
    `${pluralize(ids.length, 'línea registrada', 'líneas registradas')} · ${formatHours(totalHours)} en «${truncate(task.name, 40)}».`,
    'Ver en Odoo',
  );
  if (action === 'Ver en Odoo' && ids.length > 0) {
    await vscode.env.openExternal(
      vscode.Uri.parse(recordUrl(client.url, client.majorVersion, 'account.analytic.line', ids[0])),
    );
  }
}

interface CommitItem extends vscode.QuickPickItem {
  commit?: Commit;
}

async function pickCommits(
  available: Commit[],
  preselected: Commit[],
): Promise<Commit[] | undefined> {
  const preselectedHashes = new Set(preselected.map((commit) => commit.hash));
  const items: CommitItem[] = [];

  for (const group of groupByDay(available)) {
    items.push({ label: formatDayLabel(group.day), kind: vscode.QuickPickItemKind.Separator });
    for (const commit of group.commits) {
      items.push({
        label: commit.subject || '(sin mensaje)',
        description: `${commit.time} · ${commit.shortHash}`,
        detail: commit.body ? truncate(commit.body.replace(/\s+/g, ' '), 120) : undefined,
        picked: preselectedHashes.has(commit.hash),
        commit,
      });
    }
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Commits a registrar',
    placeHolder: 'Marca los commits que quieres convertir en horas',
    canPickMany: true,
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });

  return picked
    ?.map((item) => item.commit)
    .filter((commit): commit is Commit => commit !== undefined);
}

interface TaskItem extends vscode.QuickPickItem {
  task?: OdooTask;
  create?: boolean;
}

type TaskPick =
  | { kind: 'existing'; task: OdooTask }
  | { kind: 'create'; typed: string };

function toTaskItem(task: OdooTask): TaskItem {
  const stage = stageOf(task);
  const spent =
    typeof task.effective_hours === 'number' && task.effective_hours > 0
      ? formatHours(task.effective_hours)
      : undefined;
  return {
    // El id va en la etiqueta para que el filtro local del QuickPick no
    // descarte una tarea encontrada por número en el servidor.
    label: `#${task.id} ${task.name}`,
    description: [spent, projectOf(task)?.name ?? 'Sin proyecto'].filter(Boolean).join(' · '),
    detail: stage ? `Etapa: ${stage}` : undefined,
    task,
  };
}

function createTaskItem(suggestedName: string): TaskItem {
  return {
    label: '$(add) Crear tarea nueva…',
    description: truncate(suggestedName, 70),
    // Sin alwaysShow, el filtro local del QuickPick lo esconde al teclear.
    alwaysShow: true,
    create: true,
  };
}

function pickTask(
  deps: LogTimeDeps,
  projectId: number | undefined,
  suggestedName: string,
): Promise<TaskPick | undefined> {
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<TaskItem>();
    quickPick.title = 'Tarea de Odoo';
    quickPick.placeholder = 'Busca por nombre, o escribe el número de tarea';
    quickPick.matchOnDescription = true;
    quickPick.ignoreFocusOut = true;

    let debounce: ReturnType<typeof setTimeout> | undefined;
    let sequence = 0;
    let settled = false;

    const load = async (query: string): Promise<void> => {
      const request = ++sequence;
      quickPick.busy = true;
      try {
        const { client, schema } = deps.session.requireConnection();
        const config = vscode.workspace.getConfiguration('odooTimesheet');
        const scope = config.get<TaskScope>('taskScope', 'mine');
        const order = config.get<TaskOrder>('taskOrder', 'created');
        const limit = config.get<number>('taskLimit', 50);

        let tasks = await searchTasks(client, schema, { query, scope, order, limit, projectId });
        // Es normal querer imputar horas a una tarea que no tienes asignada;
        // si la búsqueda no devuelve nada, se reintenta sin ese filtro.
        if (tasks.length === 0 && query.trim() && scope !== 'all') {
          tasks = await searchTasks(client, schema, { query, scope: 'all', order, limit, projectId });
          if (request === sequence) {
            quickPick.title = 'Tarea de Odoo — sin coincidencias entre tus tareas, mostrando todas';
          }
        } else if (request === sequence) {
          quickPick.title = 'Tarea de Odoo';
        }

        if (request !== sequence) {
          return;
        }
        quickPick.items = [createTaskItem(suggestedName), ...tasks.map(toTaskItem)];
      } catch (error) {
        if (request !== sequence) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        deps.log.error(`Búsqueda de tareas fallida: ${message}`);
        quickPick.items = [createTaskItem(suggestedName)];
        quickPick.title = `Tarea de Odoo — error: ${truncate(message, 80)}`;
      } finally {
        if (request === sequence) {
          quickPick.busy = false;
        }
      }
    };

    quickPick.onDidChangeValue((value) => {
      if (debounce) {
        clearTimeout(debounce);
      }
      // La búsqueda es del lado del servidor, así que se espera a que el
      // usuario deje de teclear antes de disparar la consulta.
      debounce = setTimeout(() => void load(value), 250);
    });

    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0];
      if (!selected) {
        return;
      }
      settled = true;
      const typed = quickPick.value.trim();
      resolve(
        selected.create
          ? { kind: 'create', typed }
          : selected.task
            ? { kind: 'existing', task: selected.task }
            : undefined,
      );
      quickPick.hide();
    });

    quickPick.onDidHide(() => {
      if (debounce) {
        clearTimeout(debounce);
      }
      quickPick.dispose();
      if (!settled) {
        resolve(undefined);
      }
    });

    // Se muestra ya, para que crear una tarea no espere a la primera búsqueda.
    quickPick.items = [createTaskItem(suggestedName)];
    quickPick.show();
    void load('');
  });
}

/**
 * Nombre propuesto para la tarea, con el prefijo de fecha configurado. El día
 * llega resuelto desde el flujo para que coincida con el de las líneas.
 */
function suggestTaskName(commits: Commit[], day: string): string {
  const format = vscode.workspace
    .getConfiguration('odooTimesheet')
    .get<string>('taskNameDateFormat', 'MM/DD');
  const subjects = commits
    .map((commit) => commit.subject)
    .filter(Boolean)
    .join(', ');
  return truncate([formatTaskDate(day, format), subjects].filter(Boolean).join(' '), 180);
}

type LineDatePreference = 'ask' | 'today' | 'commit';

interface DateItem extends vscode.QuickPickItem {
  value: LineDate | 'custom';
}

/**
 * Decide con qué fecha se registran las horas. Con `ask`, se salta el diálogo
 * cuando todos los commits son de hoy: ahí las dos respuestas serían la misma y
 * el caso habitual no debe costar ni una pulsación.
 */
async function resolveLineDate(commits: Commit[]): Promise<LineDate | undefined> {
  const preference = vscode.workspace
    .getConfiguration('odooTimesheet')
    .get<LineDatePreference>('lineDate', 'ask');
  const today = todayLocalDay();

  if (preference === 'today') {
    return { kind: 'fixed', day: today };
  }
  if (preference === 'commit') {
    return { kind: 'perCommitDay' };
  }

  const days = [...new Set(commits.map((commit) => commit.day))];
  if (days.length === 1 && days[0] === today) {
    return { kind: 'fixed', day: today };
  }

  const items: DateItem[] = [
    {
      label: '$(calendar) Hoy',
      description: today,
      value: { kind: 'fixed', day: today },
    },
    {
      label: '$(git-commit) Fecha del commit',
      description:
        days.length === 1
          ? `${formatDayLabel(days[0])} · ${days[0]}`
          : `cada commit con su día · ${pluralize(days.length, 'día', 'días')}`,
      value: { kind: 'perCommitDay' },
    },
    {
      label: '$(edit) Otra fecha…',
      description: 'YYYY-MM-DD',
      value: 'custom',
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: '¿Con qué fecha registrar las horas?',
    ignoreFocusOut: true,
  });
  if (!picked) {
    return undefined;
  }
  if (picked.value !== 'custom') {
    return picked.value;
  }

  const input = await vscode.window.showInputBox({
    title: 'Fecha de la línea de horas',
    prompt: 'Formato YYYY-MM-DD',
    value: today,
    ignoreFocusOut: true,
    validateInput: (text) =>
      parseIsoDay(text) === undefined ? 'Escribe una fecha real en formato YYYY-MM-DD.' : undefined,
  });
  const day = input === undefined ? undefined : parseIsoDay(input);
  return day ? { kind: 'fixed', day } : undefined;
}

async function createTaskInteractively(
  deps: LogTimeDeps,
  defaultName: string,
  projectId: number | undefined,
): Promise<OdooTask | undefined> {
  const { session } = deps;

  // Una tarea sin proyecto no puede recibir horas, así que aquí sí es obligatorio.
  const targetProject =
    projectId ??
    (await pickProject(session, { title: 'Proyecto de la tarea nueva', includeAll: false }))?.id;
  if (targetProject === undefined) {
    return undefined;
  }

  const name = await vscode.window.showInputBox({
    title: 'Nombre de la tarea nueva',
    prompt: 'Se creará en Odoo antes de registrar las horas',
    value: defaultName,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'La tarea necesita un nombre.'),
  });
  if (name === undefined) {
    return undefined;
  }

  const { client, schema } = session.requireConnection();
  const assignToMe = vscode.workspace
    .getConfiguration('odooTimesheet')
    .get<boolean>('assignNewTasksToMe', true);

  const task = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Creando la tarea en Odoo…' },
    () => createTask(client, schema, { name: name.trim(), projectId: targetProject, assignToMe }),
  );

  deps.log.info(
    `Tarea #${task.id} «${task.name}» creada en el proyecto ${targetProject}${
      assignToMe ? ' y asignada a ti' : ''
    }`,
  );
  deps.tasks.refresh();
  return task;
}

interface ModeItem extends vscode.QuickPickItem {
  mode: LineMode;
}

async function pickMode(commitCount: number): Promise<LineMode | undefined> {
  if (commitCount === 1) {
    return 'grouped';
  }

  const items: ModeItem[] = [
    {
      label: '$(fold) Una línea por día',
      detail: `Agrupa los ${commitCount} commits y tú indicas el total de horas de cada día.`,
      mode: 'grouped',
    },
    {
      label: '$(list-unordered) Una línea por commit',
      detail: `Crea ${commitCount} líneas y pregunta las horas de cada commit.`,
      mode: 'per-commit',
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: '¿Cómo registrar las horas?',
    ignoreFocusOut: true,
  });
  return picked?.mode;
}

/**
 * Recorre los borradores que decidió `planLines` y pide lo que falta. En modo
 * por commit no se pregunta la descripción: ya hay un diálogo de horas por
 * commit y encadenar 2N cajas sería insufrible.
 */
async function buildLines(
  drafts: LineDraft[],
  mode: LineMode,
  taskId: number,
  projectId: number,
): Promise<TimesheetLineInput[] | undefined> {
  const lines: TimesheetLineInput[] = [];

  for (const draft of drafts) {
    const suggested = truncate(
      draft.commits
        .map((commit) => joinCommitText(commit.subject, commit.body))
        .filter(Boolean)
        .join('; '),
      MAX_DESCRIPTION,
    );

    const hours = await askHours(describeDraft(draft, mode));
    if (hours === undefined) {
      return undefined;
    }

    const description =
      mode === 'per-commit'
        ? suggested || draft.commits[0].shortHash
        : await askDescription(suggested);
    if (description === undefined) {
      return undefined;
    }

    lines.push({ date: draft.day, description, hours, taskId, projectId });
  }

  return lines;
}

function describeDraft(draft: LineDraft, mode: LineMode): string {
  if (mode === 'per-commit') {
    const commit = draft.commits[0];
    return `«${truncate(commit.subject || commit.shortHash, 60)}» · ${draft.day}`;
  }
  return `${formatDayLabel(draft.day)} (${draft.day}) · ${pluralize(draft.commits.length, 'commit', 'commits')}`;
}

async function askHours(prompt: string): Promise<number | undefined> {
  const input = await vscode.window.showInputBox({
    title: 'Horas dedicadas',
    prompt,
    placeHolder: 'Por ejemplo 2.5 o 2:30',
    ignoreFocusOut: true,
    validateInput: (value) =>
      parseHours(value) === undefined
        ? 'Escribe unas horas válidas: 1.5, 0,75 o 2:30 (máximo 24).'
        : undefined,
  });
  return input === undefined ? undefined : parseHours(input);
}

async function askDescription(suggested: string): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({
    title: 'Descripción de la línea',
    prompt: 'Es lo que se verá en la hoja de horas de Odoo',
    value: suggested,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'La descripción no puede estar vacía.'),
  });
  return input?.trim();
}
