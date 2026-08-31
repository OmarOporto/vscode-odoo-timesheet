import * as vscode from 'vscode';
import {
  findRepository,
  getAuthorEmail,
  groupByDay,
  readCommits,
  watchRepositories,
} from '../git/gitService';
import type { Commit } from '../git/types';
import { formatDayLabel, pluralize, todayLocalDay } from '../util';

export class DayNode {
  constructor(
    readonly day: string,
    readonly commits: Commit[],
  ) {}
}

export class CommitNode {
  constructor(
    readonly commit: Commit,
    readonly day: string,
  ) {}
}

export class InfoNode {
  constructor(
    readonly label: string,
    readonly icon: string,
  ) {}
}

export type CommitTreeNode = DayNode | CommitNode | InfoNode;

export class CommitsTreeProvider
  implements vscode.TreeDataProvider<CommitTreeNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<CommitTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly disposables: vscode.Disposable[] = [];
  private repoWatchers: vscode.Disposable[] = [];

  private repoRoot: string | undefined;
  private days: DayNode[] = [];
  private loaded = false;
  private loadError: string | undefined;

  constructor(private readonly log: vscode.LogOutputChannel) {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('odooTimesheet.daysBack') ||
          event.affectsConfiguration('odooTimesheet.onlyMyCommits') ||
          event.affectsConfiguration('odooTimesheet.includeMerges')
        ) {
          this.refresh();
        }
      }),
    );
    void watchRepositories(() => this.refresh()).then((disposable) => {
      this.disposables.push(disposable);
    });
  }

  refresh(): void {
    this.loaded = false;
    this.emitter.fire();
  }

  /** Todos los commits cargados, aplanados. Lo usa el flujo de registro de horas. */
  async getCommits(): Promise<Commit[]> {
    await this.ensureLoaded();
    return this.days.flatMap((day) => day.commits);
  }

  get currentRepository(): string | undefined {
    return this.repoRoot;
  }

  getTreeItem(element: CommitTreeNode): vscode.TreeItem {
    if (element instanceof DayNode) {
      const isToday = element.day === todayLocalDay();
      const item = new vscode.TreeItem(
        formatDayLabel(element.day),
        isToday
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = `day:${element.day}`;
      item.description = pluralize(element.commits.length, 'commit', 'commits');
      item.contextValue = 'day';
      item.iconPath = new vscode.ThemeIcon('calendar');
      item.tooltip = `${element.day} · ${pluralize(element.commits.length, 'commit', 'commits')}`;
      return item;
    }

    if (element instanceof CommitNode) {
      const commit = element.commit;
      const item = new vscode.TreeItem(
        commit.subject || '(sin mensaje)',
        vscode.TreeItemCollapsibleState.None,
      );
      item.id = `commit:${commit.hash}`;
      item.description = `${commit.time} · ${commit.shortHash}`;
      item.contextValue = 'commit';
      item.iconPath = new vscode.ThemeIcon('git-commit');

      // appendText escapa el markdown: el mensaje de commit es texto arbitrario.
      const tooltip = new vscode.MarkdownString();
      tooltip.appendText(commit.subject || '(sin mensaje)');
      if (commit.body) {
        tooltip.appendText(`\n\n${commit.body}`);
      }
      tooltip.appendText(`\n\n${commit.authorName} · ${commit.day} ${commit.time} · ${commit.shortHash}`);
      item.tooltip = tooltip;
      return item;
    }

    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(element.icon);
    item.contextValue = 'info';
    return item;
  }

  async getChildren(element?: CommitTreeNode): Promise<CommitTreeNode[]> {
    if (element instanceof DayNode) {
      return element.commits.map((commit) => new CommitNode(commit, element.day));
    }
    if (element) {
      return [];
    }

    await this.ensureLoaded();

    if (this.loadError) {
      return [new InfoNode(this.loadError, 'error')];
    }
    if (!this.repoRoot) {
      // La vista de bienvenida (viewsWelcome) cubre este caso.
      return [];
    }
    if (this.days.length === 0) {
      const days = vscode.workspace.getConfiguration('odooTimesheet').get<number>('daysBack', 14);
      return [new InfoNode(`Sin commits tuyos en los últimos ${days} días`, 'info')];
    }
    return this.days;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    this.loadError = undefined;

    try {
      const root = await findRepository();
      this.setRepository(root);
      await vscode.commands.executeCommand('setContext', 'odooTimesheet.hasRepo', Boolean(root));
      if (!root) {
        this.days = [];
        return;
      }

      const config = vscode.workspace.getConfiguration('odooTimesheet');
      const onlyMine = config.get<boolean>('onlyMyCommits', true);
      const authorEmail = onlyMine ? await getAuthorEmail(root) : undefined;
      if (onlyMine && !authorEmail) {
        this.log.warn('git config user.email no está definido: se mostrarán los commits de todos los autores.');
      }

      const commits = await readCommits(root, {
        days: config.get<number>('daysBack', 14),
        authorEmail,
        includeMerges: config.get<boolean>('includeMerges', false),
      });
      this.days = groupByDay(commits).map((group) => new DayNode(group.day, group.commits));
      this.log.debug(`${commits.length} commits leídos de ${root}`);
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
      this.log.error(this.loadError);
      this.days = [];
    }
  }

  /** Vigila `.git/logs/HEAD` para que un commit nuevo aparezca sin refrescar a mano. */
  private setRepository(root: string | undefined): void {
    if (root === this.repoRoot) {
      return;
    }
    this.repoRoot = root;
    vscode.Disposable.from(...this.repoWatchers).dispose();
    this.repoWatchers = [];
    if (!root) {
      return;
    }

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(root), '.git/logs/HEAD'),
    );
    const onChange = () => this.refresh();
    this.repoWatchers.push(
      watcher,
      watcher.onDidChange(onChange),
      watcher.onDidCreate(onChange),
      watcher.onDidDelete(onChange),
    );
  }

  dispose(): void {
    vscode.Disposable.from(...this.repoWatchers, ...this.disposables).dispose();
    this.emitter.dispose();
  }
}
