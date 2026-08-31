import * as vscode from 'vscode';
import { groupByDay } from '../git/gitService';
import type { Commit } from '../git/types';
import { projectOf, recordUrl, searchTasks, stageOf, type OdooTask, type TaskScope } from '../odoo/tasks';
import { createTimesheetLines, type TimesheetLineInput } from '../odoo/timesheets';
import type { OdooSession } from '../state';
import { formatDayLabel, formatHours, parseHours, pluralize, truncate } from '../util';
import { CommitNode, DayNode, type CommitsTreeProvider } from '../views/commitsTree';
import { TaskNode, type TasksTreeProvider } from '../views/tasksTree';

export interface LogTimeDeps {
  session: OdooSession;
  commits: CommitsTreeProvider;
  tasks: TasksTreeProvider;
  log: vscode.LogOutputChannel;
}

type LineMode = 'grouped' | 'per-commit';

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

  // El comando entra desde tres sitios distintos del árbol; cada uno precarga
  // una parte del flujo.
  let preselected: Commit[] = [];
  let presetTask: OdooTask | undefined;
  if (node instanceof DayNode) {
    preselected = node.commits;
  } else if (node instanceof CommitNode) {
    preselected = [node.commit];
  } else if (node instanceof TaskNode) {
    presetTask = node.task;
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

  const task = presetTask ?? (await pickTask(deps));
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

  const lines =
    mode === 'grouped'
      ? await buildGroupedLines(selected, task.id, project.id)
      : await buildPerCommitLines(selected, task.id, project.id);
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
      vscode.Uri.parse(recordUrl(client.url, 'account.analytic.line', ids[0])),
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
  task: OdooTask;
}

function toTaskItem(task: OdooTask): TaskItem {
  const stage = stageOf(task);
  return {
    // El id va en la etiqueta para que el filtro local del QuickPick no
    // descarte una tarea encontrada por número en el servidor.
    label: `#${task.id} ${task.name}`,
    description: projectOf(task)?.name ?? 'Sin proyecto',
    detail: stage ? `Etapa: ${stage}` : undefined,
    task,
  };
}

function pickTask(deps: LogTimeDeps): Promise<OdooTask | undefined> {
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
        const scope = config.get<TaskScope>('taskScope', 'assigned');
        const limit = config.get<number>('taskLimit', 50);

        let tasks = await searchTasks(client, schema, { query, scope, limit });
        // Es normal querer imputar horas a una tarea que no tienes asignada;
        // si la búsqueda no devuelve nada, se reintenta sin ese filtro.
        if (tasks.length === 0 && query.trim() && scope === 'assigned') {
          tasks = await searchTasks(client, schema, { query, scope: 'all', limit });
          if (request === sequence) {
            quickPick.title = 'Tarea de Odoo — sin coincidencias entre tus tareas, mostrando todas';
          }
        } else if (request === sequence) {
          quickPick.title = 'Tarea de Odoo';
        }

        if (request !== sequence) {
          return;
        }
        quickPick.items = tasks.map(toTaskItem);
      } catch (error) {
        if (request !== sequence) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        deps.log.error(`Búsqueda de tareas fallida: ${message}`);
        quickPick.items = [];
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
      resolve(selected.task);
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

    quickPick.show();
    void load('');
  });
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

async function buildGroupedLines(
  commits: Commit[],
  taskId: number,
  projectId: number,
): Promise<TimesheetLineInput[] | undefined> {
  const lines: TimesheetLineInput[] = [];

  // Si la selección abarca varios días se crea una línea por día: imputar el
  // trabajo del lunes con fecha de hoy falsearía la hoja de horas.
  for (const group of groupByDay(commits)) {
    const subjects = group.commits.map((commit) => commit.subject).filter(Boolean);

    const hours = await askHours(
      `${formatDayLabel(group.day)} (${group.day}) · ${pluralize(group.commits.length, 'commit', 'commits')}`,
    );
    if (hours === undefined) {
      return undefined;
    }

    const description = await askDescription(truncate(subjects.join('; '), 240));
    if (description === undefined) {
      return undefined;
    }

    lines.push({ date: group.day, description, hours, taskId, projectId });
  }

  return lines;
}

async function buildPerCommitLines(
  commits: Commit[],
  taskId: number,
  projectId: number,
): Promise<TimesheetLineInput[] | undefined> {
  const lines: TimesheetLineInput[] = [];

  for (const commit of commits) {
    const hours = await askHours(`«${truncate(commit.subject || commit.shortHash, 60)}»`);
    if (hours === undefined) {
      return undefined;
    }
    lines.push({
      date: commit.day,
      description: commit.subject || commit.shortHash,
      hours,
      taskId,
      projectId,
    });
  }

  return lines;
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
