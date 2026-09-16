import * as vscode from 'vscode';
import { readHolidays } from '../state';
import { weekdayOf } from '../util';

/**
 * Colorea en la vista de horas los días que no reclaman horas: los festivos que
 * marcaste y los que no son laborables.
 *
 * Mismo mecanismo que `commitDecorations`: un `FileDecorationProvider` sobre una
 * URI sintética. Colorear la etiqueta de un `TreeItem` no se puede de otra
 * forma — `iconPath` solo tiñe el icono — y así el color sale del tema en vez de
 * estar escrito a mano.
 */

const SCHEME = 'odoo-timesheet-hours-day';

export function dayUri(day: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: `/${day}` });
}

export class HolidayDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== SCHEME) {
      return undefined;
    }
    const day = uri.path.slice(1);
    const config = vscode.workspace.getConfiguration('odooTimesheet');
    const workdays = config.get<number[]>('hoursWorkdays', [1, 2, 3, 4, 5, 6]);

    if (readHolidays().includes(day)) {
      return {
        color: new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'),
        tooltip: 'Festivo: no cuenta para la meta',
      };
    }
    if (!workdays.includes(weekdayOf(day))) {
      return {
        color: new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'),
        tooltip: 'Día no laborable: no cuenta para la meta',
      };
    }
    return undefined;
  }

  /** Repinta sin reconstruir el árbol. Sin argumento, todos los días. */
  refresh(days?: string[]): void {
    this.emitter.fire(days?.map(dayUri));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
