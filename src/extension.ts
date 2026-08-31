import * as vscode from 'vscode';
import { connectCommand, disconnectCommand, testConnectionCommand } from './commands/connect';
import { logTimeCommand } from './commands/logTime';
import { recordUrl } from './odoo/tasks';
import { OdooSession } from './state';
import { CommitNode, CommitsTreeProvider } from './views/commitsTree';
import { TaskNode, TasksTreeProvider } from './views/tasksTree';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Odoo Timesheet', { log: true });
  const session = new OdooSession(context, log);

  const commitsProvider = new CommitsTreeProvider(log);
  const tasksProvider = new TasksTreeProvider(session, log);

  const commitsView = vscode.window.createTreeView('odooTimesheet.commits', {
    treeDataProvider: commitsProvider,
    showCollapseAll: true,
  });
  const tasksView = vscode.window.createTreeView('odooTimesheet.tasks', {
    treeDataProvider: tasksProvider,
  });

  const deps = { session, commits: commitsProvider, tasks: tasksProvider, log };

  context.subscriptions.push(
    log,
    session,
    commitsProvider,
    tasksProvider,
    commitsView,
    tasksView,

    vscode.commands.registerCommand('odooTimesheet.connect', () => connectCommand(session, log)),
    vscode.commands.registerCommand('odooTimesheet.disconnect', () => disconnectCommand(session)),
    vscode.commands.registerCommand('odooTimesheet.testConnection', () =>
      testConnectionCommand(session, log),
    ),
    vscode.commands.registerCommand('odooTimesheet.showLog', () => log.show()),

    vscode.commands.registerCommand('odooTimesheet.refreshCommits', () => commitsProvider.refresh()),
    vscode.commands.registerCommand('odooTimesheet.refreshTasks', () => tasksProvider.refresh()),

    vscode.commands.registerCommand('odooTimesheet.searchTasks', async () => {
      const filter = await vscode.window.showInputBox({
        title: 'Buscar tareas en Odoo',
        prompt: 'Nombre de la tarea o número. Deja vacío para quitar el filtro.',
        value: tasksProvider.currentFilter ?? '',
      });
      if (filter === undefined) {
        return;
      }
      tasksProvider.setFilter(filter);
      tasksView.description = tasksProvider.currentFilter
        ? `filtro: ${tasksProvider.currentFilter}`
        : undefined;
    }),

    vscode.commands.registerCommand('odooTimesheet.setDateRange', async () => {
      const config = vscode.workspace.getConfiguration('odooTimesheet');
      const current = config.get<number>('daysBack', 14);
      const options = ['7', '14', '30', '90', 'Otro…'];
      const picked = await vscode.window.showQuickPick(options, {
        title: `Días de historial (actual: ${current})`,
      });
      if (!picked) {
        return;
      }

      let days = Number(picked);
      if (picked === 'Otro…') {
        const custom = await vscode.window.showInputBox({
          title: 'Días de historial',
          value: String(current),
          validateInput: (value) => {
            const parsed = Number(value);
            return Number.isInteger(parsed) && parsed >= 1 && parsed <= 365
              ? undefined
              : 'Escribe un número entero entre 1 y 365.';
          },
        });
        if (custom === undefined) {
          return;
        }
        days = Number(custom);
      }
      await config.update('daysBack', days, vscode.ConfigurationTarget.Global);
    }),

    vscode.commands.registerCommand('odooTimesheet.logTime', (node?: unknown) =>
      logTimeCommand(deps, node),
    ),

    vscode.commands.registerCommand('odooTimesheet.openTaskInBrowser', async (node?: unknown) => {
      const connection = session.connection;
      if (!(node instanceof TaskNode) || !connection) {
        return;
      }
      await vscode.env.openExternal(
        vscode.Uri.parse(recordUrl(connection.client.url, 'project.task', node.task.id)),
      );
    }),

    vscode.commands.registerCommand('odooTimesheet.copyCommitHash', async (node?: unknown) => {
      if (!(node instanceof CommitNode)) {
        return;
      }
      await vscode.env.clipboard.writeText(node.commit.hash);
      void vscode.window.showInformationMessage(`Hash copiado: ${node.commit.shortHash}`);
    }),
  );

  void session.restore();
}

export function deactivate(): void {
  // Todo se limpia vía context.subscriptions.
}
