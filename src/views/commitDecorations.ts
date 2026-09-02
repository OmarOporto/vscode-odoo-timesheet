import * as vscode from 'vscode';
import type { CommitRegistry } from '../registry';
import { formatHours, truncate } from '../util';

/**
 * Colorea en el árbol los commits que ya se registraron.
 *
 * Se usa `FileDecorationProvider`, el mismo mecanismo con el que git colorea
 * archivos en el Explorador: así la marca respeta el tema del usuario en vez de
 * llevar un color escrito a mano.
 */

const SCHEME = 'odoo-timesheet-commit';

/** URI sintética por commit; es lo que enlaza el nodo del árbol con su decoración. */
export function commitUri(hash: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: `/${hash}` });
}

export class RegisteredCommitDecorations
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  constructor(private readonly registry: CommitRegistry) {}

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== SCHEME || !isEnabled()) {
      return undefined;
    }
    const info = this.registry.get(uri.path.slice(1));
    if (!info) {
      return undefined;
    }

    return {
      // El badge admite como mucho dos caracteres.
      badge: '✓',
      color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
      tooltip: `Ya registrado: ${formatHours(info.hours)} en «${truncate(info.taskName, 40)}» el ${info.day}`,
    };
  }

  /** Refresca la marca sin tener que reconstruir el árbol entero. */
  refresh(hashes?: string[]): void {
    this.emitter.fire(hashes?.map(commitUri));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

export function isEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('odooTimesheet')
    .get<boolean>('markRegisteredCommits', true);
}
