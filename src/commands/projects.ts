import * as vscode from 'vscode';
import { listProjects, type OdooProject } from '../odoo/tasks';
import { readPinnedProject, writePinnedProject, type OdooSession } from '../state';
import { pluralize } from '../util';

export interface ProjectChoice {
  /** `undefined` significa «todos los proyectos». */
  id?: number;
  name: string;
}

interface ProjectItem extends vscode.QuickPickItem {
  choice: ProjectChoice;
}

const ALL_PROJECTS: ProjectChoice = { name: 'Todos los proyectos' };

function toItem(project: OdooProject): ProjectItem {
  return {
    label: project.name,
    description:
      project.task_count !== undefined ? pluralize(project.task_count, 'tarea', 'tareas') : `#${project.id}`,
    choice: { id: project.id, name: project.name },
  };
}

/**
 * QuickPick de proyectos. Se cargan todos de golpe (son pocos comparados con las
 * tareas) para que el filtrado sea local e instantáneo.
 */
export async function pickProject(
  session: OdooSession,
  options: { title: string; includeAll: boolean },
): Promise<ProjectChoice | undefined> {
  const { client, schema } = session.requireConnection();

  const projects = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Cargando proyectos de Odoo…' },
    () => listProjects(client, schema, { limit: 200 }),
  );

  const items: ProjectItem[] = projects.map(toItem);
  if (options.includeAll) {
    items.unshift({
      label: '$(list-flat) Todos los proyectos',
      description: 'sin filtrar por proyecto',
      choice: ALL_PROJECTS,
    });
  }
  if (items.length === 0) {
    void vscode.window.showWarningMessage(
      'No hay proyectos con hojas de horas habilitadas que puedas ver en Odoo.',
    );
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: options.title,
    placeHolder: 'Busca por nombre',
    matchOnDescription: true,
    ignoreFocusOut: true,
  });
  return picked?.choice;
}

/** Fija (o quita) el proyecto de la vista de tareas. */
export async function selectProjectCommand(session: OdooSession): Promise<void> {
  if (!session.isConnected) {
    const action = await vscode.window.showWarningMessage(
      'Conéctate a Odoo para elegir un proyecto.',
      'Conectar a Odoo',
    );
    if (action === 'Conectar a Odoo') {
      await vscode.commands.executeCommand('odooTimesheet.connect');
    }
    return;
  }

  const choice = await pickProject(session, {
    title: 'Proyecto a mostrar en el panel',
    includeAll: true,
  });
  if (!choice) {
    return;
  }
  await writePinnedProject(choice.id === undefined ? undefined : { id: choice.id, name: choice.name });
}

export async function pinProjectCommand(project: { id: number; name: string }): Promise<void> {
  await writePinnedProject(project);
}

export async function unpinProjectCommand(): Promise<void> {
  await writePinnedProject(undefined);
}

/** Texto para la cabecera de la vista: proyecto fijado y filtro de búsqueda. */
export function describeTasksView(filter: string | undefined): string | undefined {
  const parts: string[] = [];
  const pinned = readPinnedProject();
  if (pinned) {
    parts.push(pinned.name);
  }
  if (filter) {
    parts.push(`filtro: ${filter}`);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
