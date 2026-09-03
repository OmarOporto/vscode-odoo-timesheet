import * as vscode from 'vscode';
import {
  changePasswordCommand,
  connectCommand,
  disconnectCommand,
  logConfiguration,
  testConnectionCommand,
  type RuntimeInfo,
} from './commands/connect';
import { diagnoseTasksCommand } from './commands/diagnose';
import { logTimeCommand } from './commands/logTime';
import {
  describeTasksView,
  pinProjectCommand,
  selectProjectCommand,
  unpinProjectCommand,
} from './commands/projects';
import { selectRepositoryCommand } from './commands/repository';
import { recordUrl } from './odoo/tasks';
import { pluralize } from './util';
import { CommitRegistry, REGISTRY_KEY } from './registry';
import { OdooSession } from './state';
import { RegisteredCommitDecorations } from './views/commitDecorations';
import { CommitNode, CommitsTreeProvider } from './views/commitsTree';
import { ProjectNode, ShowMoreNode, TaskNode, TasksTreeProvider } from './views/tasksTree';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Odoo Timesheet', { log: true });
  const session = new OdooSession(context, log);

  // Primera línea del registro: la versión que de verdad se cargó. Una ventana
  // abierta desde antes de actualizar sigue ejecutando el código anterior, y sin
  // esto se confunde con un fallo de la extensión.
  const version = String(context.extension.packageJSON.version ?? 'desconocida');
  const host = vscode.env.remoteName ?? 'local';
  log.info(`Odoo Timesheet ${version} activada · host ${host}`);

  // Si el usuario tiene activada la sincronización de VS Code, las marcas
  // viajan entre sus instalaciones (Windows y WSL son almacenes distintos).
  context.globalState.setKeysForSync([REGISTRY_KEY]);
  const registry = new CommitRegistry(context.globalState);
  const decorations = new RegisteredCommitDecorations(registry);

  // Función, no valor: `marks` tiene que reflejar el estado del momento.
  const runtime = (): RuntimeInfo => ({ version, host, marks: registry.size });

  const commitsProvider = new CommitsTreeProvider(log, registry);
  const tasksProvider = new TasksTreeProvider(session, log);

  const commitsView = vscode.window.createTreeView('odooTimesheet.commits', {
    treeDataProvider: commitsProvider,
    showCollapseAll: true,
  });
  const tasksView = vscode.window.createTreeView('odooTimesheet.tasks', {
    treeDataProvider: tasksProvider,
    showCollapseAll: true,
  });

  const syncTasksHeader = (): void => {
    tasksView.description = describeTasksView(tasksProvider.currentFilter);
  };
  const syncCommitsHeader = (): void => {
    void commitsProvider.describeRepositories().then((description) => {
      commitsView.description = description;
    });
  };
  syncTasksHeader();
  syncCommitsHeader();

  const deps = {
    session,
    commits: commitsProvider,
    tasks: tasksProvider,
    registry,
    decorations,
    log,
  };

  context.subscriptions.push(
    log,
    session,
    commitsProvider,
    tasksProvider,
    commitsView,
    tasksView,
    decorations,
    vscode.window.registerFileDecorationProvider(decorations),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('odooTimesheet.projectId')) {
        syncTasksHeader();
      }
      if (event.affectsConfiguration('odooTimesheet.repositoryPath')) {
        syncCommitsHeader();
      }
      if (event.affectsConfiguration('odooTimesheet.markRegisteredCommits')) {
        decorations.refresh();
        commitsProvider.redraw();
      }
    }),
    commitsProvider.onDidChangeTreeData(() => syncCommitsHeader()),

    vscode.commands.registerCommand('odooTimesheet.connect', () => connectCommand(session, log)),
    vscode.commands.registerCommand('odooTimesheet.disconnect', () => disconnectCommand(session)),
    vscode.commands.registerCommand('odooTimesheet.changePassword', () =>
      changePasswordCommand(session, log),
    ),
    vscode.commands.registerCommand('odooTimesheet.testConnection', () =>
      testConnectionCommand(session, log, runtime),
    ),
    vscode.commands.registerCommand('odooTimesheet.diagnoseTasks', () =>
      diagnoseTasksCommand(session, log),
    ),
    vscode.commands.registerCommand('odooTimesheet.showLog', () => {
      logConfiguration(log, runtime);
      log.show();
    }),

    vscode.commands.registerCommand('odooTimesheet.openSettings', () =>
      // El id sale del propio contexto: así no hay que mantener sincronizado el
      // publisher con una cadena escrita a mano.
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),
    ),
    vscode.commands.registerCommand('odooTimesheet.openSettingsJson', () =>
      vscode.commands.executeCommand('workbench.action.openSettingsJson'),
    ),

    vscode.commands.registerCommand('odooTimesheet.refreshCommits', () => commitsProvider.refresh()),
    vscode.commands.registerCommand('odooTimesheet.refreshTasks', () => tasksProvider.refresh()),

    vscode.commands.registerCommand('odooTimesheet.selectRepository', () =>
      selectRepositoryCommand(log),
    ),
    vscode.commands.registerCommand('odooTimesheet.showMoreTasks', (node?: unknown) => {
      if (node instanceof ShowMoreNode) {
        tasksProvider.showMore(node);
      }
    }),

    vscode.commands.registerCommand('odooTimesheet.selectProject', async () => {
      await selectProjectCommand(session);
      syncTasksHeader();
    }),
    vscode.commands.registerCommand('odooTimesheet.pinProject', async (node?: unknown) => {
      if (!(node instanceof ProjectNode)) {
        return;
      }
      await pinProjectCommand({ id: node.project.id, name: node.project.name });
      syncTasksHeader();
    }),
    vscode.commands.registerCommand('odooTimesheet.unpinProject', async () => {
      await unpinProjectCommand();
      syncTasksHeader();
    }),

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
      syncTasksHeader();
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

    vscode.commands.registerCommand('odooTimesheet.openInBrowser', async (node?: unknown) => {
      const connection = session.connection;
      if (!connection) {
        return;
      }
      const target =
        node instanceof TaskNode
          ? { model: 'project.task', id: node.task.id }
          : node instanceof ProjectNode
            ? { model: 'project.project', id: node.project.id }
            : undefined;
      if (!target) {
        return;
      }
      await vscode.env.openExternal(
        vscode.Uri.parse(
          recordUrl(connection.client.url, connection.client.majorVersion, target.model, target.id),
        ),
      );
    }),

    vscode.commands.registerCommand('odooTimesheet.forgetCommitMark', async (node?: unknown) => {
      if (!(node instanceof CommitNode)) {
        return;
      }
      await registry.forget([node.commit.hash]);
      decorations.refresh([node.commit.hash]);
      commitsProvider.redraw();
    }),

    vscode.commands.registerCommand('odooTimesheet.clearCommitMarks', async () => {
      const count = registry.size;
      if (count === 0) {
        void vscode.window.showInformationMessage('No hay commits marcados como registrados.');
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `Se olvidarán ${pluralize(count, 'marca', 'marcas')}. Las horas ya registradas en Odoo no se tocan.`,
        { modal: true },
        'Olvidar marcas',
      );
      if (answer !== 'Olvidar marcas') {
        return;
      }
      await registry.clear();
      decorations.refresh();
      commitsProvider.redraw();
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
