import * as vscode from 'vscode';
import { toggleHoliday } from '../state';
import { formatDayLabel, parseIsoDay, todayLocalDay } from '../util';
import { HoursDayNode } from '../views/hoursTree';

/**
 * Marca o desmarca un día como festivo.
 *
 * El mismo comando sirve para las dos direcciones: el menú decide cuál ofrecer
 * según el `contextValue` del nodo, así que el usuario nunca ve las dos.
 *
 * Desde la paleta no hay nodo, así que se pregunta la fecha: es la vía para
 * marcar un festivo que aún no ha llegado, porque la vista solo lista días
 * transcurridos.
 */
export async function toggleHolidayCommand(node?: unknown): Promise<void> {
  const day = node instanceof HoursDayNode ? node.summary.day : await askDay();
  if (!day) {
    return;
  }

  const isHoliday = await toggleHoliday(day);
  void vscode.window.showInformationMessage(
    isHoliday
      ? `${formatDayLabel(day)} marcado como festivo: deja de contar para la meta.`
      : `${formatDayLabel(day)} vuelve a ser un día normal.`,
  );
}

function askDay(): Thenable<string | undefined> {
  return vscode.window
    .showInputBox({
      title: 'Festivo',
      prompt: 'Fecha del día festivo, en formato AAAA-MM-DD',
      value: todayLocalDay(),
      ignoreFocusOut: true,
      validateInput: (value) =>
        parseIsoDay(value) ? undefined : 'Escribe una fecha válida, por ejemplo 2026-09-15.',
    })
    .then((value) => (value ? parseIsoDay(value) : undefined));
}
