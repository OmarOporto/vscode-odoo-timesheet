import * as vscode from 'vscode';
import { projectOf, searchTasks, stageOf, type OdooTask, type TaskScope } from '../odoo/tasks';
import type { OdooSession } from '../state';

export class TaskNode {
  constructor(readonly task: OdooTask) {}
}

export class TaskInfoNode {
  constructor(
    readonly label: string,
    readonly icon: string,
  ) {}
}

export type TaskTreeNode = TaskNode | TaskInfoNode;

export class TasksTreeProvider implements vscode.TreeDataProvider<TaskTreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TaskTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly disposables: vscode.Disposable[] = [];
  private filter: string | undefined;

  constructor(
    private readonly session: OdooSession,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.disposables.push(
      session.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('odooTimesheet.taskScope') ||
          event.affectsConfiguration('odooTimesheet.taskLimit')
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
    this.emitter.fire();
  }

  getTreeItem(element: TaskTreeNode): vscode.TreeItem {
    if (element instanceof TaskNode) {
      const task = element.task;
      const project = projectOf(task);
      const stage = stageOf(task);

      const item = new vscode.TreeItem(task.name, vscode.TreeItemCollapsibleState.None);
      item.id = `task:${task.id}`;
      item.description = project?.name ?? 'Sin proyecto';
      item.contextValue = 'task';
      item.iconPath = new vscode.ThemeIcon('checklist');

      const tooltip = new vscode.MarkdownString();
      tooltip.appendText(`#${task.id} ${task.name}`);
      tooltip.appendText(`\n\nProyecto: ${project?.name ?? 'ninguno'}`);
      if (stage) {
        tooltip.appendText(`\nEtapa: ${stage}`);
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
    if (element) {
      return [];
    }
    const connection = this.session.connection;
    if (!connection) {
      // La vista de bienvenida ofrece el botón de conectar.
      return [];
    }

    const config = vscode.workspace.getConfiguration('odooTimesheet');
    try {
      const tasks = await searchTasks(connection.client, connection.schema, {
        query: this.filter,
        scope: config.get<TaskScope>('taskScope', 'assigned'),
        limit: config.get<number>('taskLimit', 50),
      });
      if (tasks.length === 0) {
        return [
          new TaskInfoNode(
            this.filter
              ? `Sin resultados para «${this.filter}»`
              : 'No hay tareas que mostrar con el filtro actual',
            'info',
          ),
        ];
      }
      return tasks.map((task) => new TaskNode(task));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`Error cargando tareas: ${message}`);
      return [new TaskInfoNode(message, 'error')];
    }
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
    this.emitter.dispose();
  }
}
