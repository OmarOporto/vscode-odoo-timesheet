import * as vscode from 'vscode';
import {
  listProjects,
  projectOf,
  searchTasks,
  stageOf,
  type OdooProject,
  type OdooTask,
  type TaskOrder,
  type TaskScope,
} from '../odoo/tasks';
import { readPinnedProject, type OdooSession } from '../state';
import { formatHours, pluralize } from '../util';

export class ProjectNode {
  constructor(readonly project: OdooProject) {}
}

export class TaskNode {
  constructor(
    readonly task: OdooTask,
    /** Cierto cuando cuelga de un proyecto: entonces el proyecto sobra en la etiqueta. */
    readonly insideProject = false,
  ) {}
}

export class ShowMoreNode {
  constructor(
    readonly projectId: number,
    /** Cuántas se están mostrando ya, para saber cuánto pedir después. */
    readonly loaded: number,
  ) {}
}

export class TaskInfoNode {
  constructor(
    readonly label: string,
    readonly icon: string,
  ) {}
}

export type TaskTreeNode = ProjectNode | TaskNode | ShowMoreNode | TaskInfoNode;

export class TasksTreeProvider implements vscode.TreeDataProvider<TaskTreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TaskTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly disposables: vscode.Disposable[] = [];
  private filter: string | undefined;
  /** Tamaño de página ampliado por proyecto, solo en memoria. */
  private readonly pageSizes = new Map<number, number>();

  constructor(
    private readonly session: OdooSession,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.disposables.push(
      session.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('odooTimesheet.taskScope') ||
          event.affectsConfiguration('odooTimesheet.taskLimit') ||
          event.affectsConfiguration('odooTimesheet.taskOrder') ||
          event.affectsConfiguration('odooTimesheet.tasksPerProject') ||
          event.affectsConfiguration('odooTimesheet.projectId')
        ) {
          this.refresh();
        }
      }),
    );
  }

  get currentFilter(): string | undefined {
    return this.filter;
  }

  setFilter(filter: string | undefined): void {
    this.filter = filter?.trim() ? filter.trim() : undefined;
    this.refresh();
  }

  refresh(): void {
    this.pageSizes.clear();
    this.emitter.fire();
  }

  /** Amplía la página de un proyecto concreto sin tocar la de los demás. */
  showMore(node: ShowMoreNode): void {
    this.pageSizes.set(node.projectId, node.loaded + this.basePageSize());
    this.emitter.fire();
  }

  private basePageSize(): number {
    return vscode.workspace.getConfiguration('odooTimesheet').get<number>('tasksPerProject', 10);
  }

  getTreeItem(element: TaskTreeNode): vscode.TreeItem {
    if (element instanceof ProjectNode) {
      const project = element.project;
      const item = new vscode.TreeItem(project.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `project:${project.id}`;
      item.contextValue = 'project';
      item.iconPath = new vscode.ThemeIcon('folder');
      if (project.task_count !== undefined) {
        item.description = pluralize(project.task_count, 'tarea', 'tareas');
      }
      item.tooltip = `Proyecto #${project.id} · ${project.name}`;
      return item;
    }

    if (element instanceof ShowMoreNode) {
      const item = new vscode.TreeItem('Mostrar más…', vscode.TreeItemCollapsibleState.None);
      item.id = `more:${element.projectId}:${element.loaded}`;
      item.description = `${element.loaded} mostradas`;
      item.contextValue = 'showMore';
      item.iconPath = new vscode.ThemeIcon('ellipsis');
      item.command = {
        command: 'odooTimesheet.showMoreTasks',
        title: 'Mostrar más',
        arguments: [element],
      };
      return item;
    }

    if (element instanceof TaskNode) {
      const task = element.task;
      const project = projectOf(task);
      const stage = stageOf(task);

      const item = new vscode.TreeItem(task.name, vscode.TreeItemCollapsibleState.None);
      item.id = `task:${task.id}`;
      item.contextValue = 'task';
      item.iconPath = new vscode.ThemeIcon('checklist');

      // Las horas ya imputadas son el dato que importa aquí. Dentro de un
      // proyecto, repetir el proyecto es ruido: mejor la etapa.
      const spent =
        typeof task.effective_hours === 'number' && task.effective_hours > 0
          ? formatHours(task.effective_hours)
          : undefined;
      const context = element.insideProject ? stage : project?.name;
      item.description = [spent, context].filter(Boolean).join(' · ') || `#${task.id}`;

      const tooltip = new vscode.MarkdownString();
      tooltip.appendText(`#${task.id} ${task.name}`);
      tooltip.appendText(`\n\nProyecto: ${project?.name ?? 'ninguno'}`);
      if (stage) {
        tooltip.appendText(`\nEtapa: ${stage}`);
      }
      if (spent) {
        tooltip.appendText(`\nHoras imputadas: ${spent}`);
      }
      if (task.write_date) {
        tooltip.appendText(`\nÚltima modificación: ${task.write_date} UTC`);
      }
      item.tooltip = tooltip;
      return item;
    }

    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(element.icon);
    item.contextValue = 'info';
    return item;
  }

  async getChildren(element?: TaskTreeNode): Promise<TaskTreeNode[]> {
    if (element instanceof TaskNode || element instanceof TaskInfoNode || element instanceof ShowMoreNode) {
      return [];
    }
    const connection = this.session.connection;
    if (!connection) {
      // La vista de bienvenida ofrece el botón de conectar.
      return [];
    }

    const config = vscode.workspace.getConfiguration('odooTimesheet');
    const scope = config.get<TaskScope>('taskScope', 'mine');
    const order = config.get<TaskOrder>('taskOrder', 'created');

    try {
      if (element instanceof ProjectNode) {
        return this.paginate(element.project.id, scope, order, 'Este proyecto no tiene tareas que mostrar');
      }

      // Buscando texto, agrupar por proyecto estorba: lista plana y ancha.
      if (this.filter) {
        const tasks = await searchTasks(connection.client, connection.schema, {
          query: this.filter,
          scope,
          order,
          limit: config.get<number>('taskLimit', 50),
        });
        return tasks.length === 0
          ? [new TaskInfoNode(`Sin resultados para «${this.filter}»`, 'info')]
          : tasks.map((task) => new TaskNode(task, false));
      }

      const pinned = readPinnedProject();
      if (pinned) {
        return this.paginate(pinned.id, scope, order, `«${pinned.name}» no tiene tareas que mostrar`);
      }

      const projects = await listProjects(connection.client, connection.schema, { limit: 200 });
      if (projects.length === 0) {
        return [new TaskInfoNode('No hay proyectos con hojas de horas habilitadas', 'info')];
      }
      return projects.map((project) => new ProjectNode(project));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`Error cargando la vista de tareas: ${message}`);
      return [new TaskInfoNode(message, 'error')];
    }
  }

  /**
   * Pide una tarea de más que el tamaño de página: si vuelve, es que hay más y
   * toca ofrecer «Mostrar más». Es una consulta en vez de dos.
   */
  private async paginate(
    projectId: number,
    scope: TaskScope,
    order: TaskOrder,
    emptyLabel: string,
  ): Promise<TaskTreeNode[]> {
    const { client, schema } = this.session.requireConnection();
    const pageSize = this.pageSizes.get(projectId) ?? this.basePageSize();

    const tasks = await searchTasks(client, schema, {
      scope,
      order,
      projectId,
      limit: pageSize + 1,
    });

    if (tasks.length === 0) {
      return [new TaskInfoNode(emptyLabel, 'info')];
    }

    const visible = tasks.slice(0, pageSize);
    const nodes: TaskTreeNode[] = visible.map((task) => new TaskNode(task, true));
    if (tasks.length > pageSize) {
      nodes.push(new ShowMoreNode(projectId, visible.length));
    }
    return nodes;
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
    this.emitter.dispose();
  }
}
