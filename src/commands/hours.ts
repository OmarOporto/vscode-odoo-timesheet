import * as vscode from 'vscode';
import { readDayTargets, toggleHoliday, writeDayTarget } from '../state';
import { formatDayLabel, formatHours, parseIsoDay, parseTarget, todayLocalDay } from '../util';
import { HoursBarNode, HoursDayNode } from '../views/hoursTree';

/** Tope de una meta mensual. Ni el mes más largo trabajado da para más. */
const MAX_MONTHLY = 400;

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

/**
 * Fija la meta del mes. Vacío o `0` la devuelven al cálculo automático a partir
 * de la meta diaria y los días laborables.
 */
export async function setMonthlyTargetCommand(): Promise<void> {
  const config = vscode.workspace.getConfiguration('odooTimesheet');
  const current = config.get<number>('hoursMonthlyTarget', 0);

  const input = await vscode.window.showInputBox({
    title: 'Meta del mes',
    prompt: 'Horas que quieres cubrir este mes. Déjalo vacío para calcularla desde la meta diaria.',
    placeHolder: 'Por ejemplo 176',
    value: current > 0 ? String(current) : '',
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim() === '' || parseTarget(value, MAX_MONTHLY) !== undefined
        ? undefined
        : `Escribe unas horas entre 0 y ${MAX_MONTHLY}, o déjalo vacío.`,
  });
  if (input === undefined) {
    return;
  }

  const hours = input.trim() === '' ? 0 : (parseTarget(input, MAX_MONTHLY) ?? 0);
  await config.update('hoursMonthlyTarget', hours, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(
    hours > 0
      ? `Meta del mes: ${formatHours(hours)}.`
      : 'Meta del mes automática: días laborables × meta diaria.',
  );
}

/**
 * Fija la meta de un día concreto, como excepción a la general. Vacío la borra.
 *
 * Desde la paleta no hay nodo, así que se pregunta la fecha: es la vía para
 * poner la meta de un día que aún no ha llegado.
 */
export async function setDayTargetCommand(node?: unknown): Promise<void> {
  const day = dayOf(node) ?? (await askDay('Meta de un día'));
  if (!day) {
    return;
  }

  const current = readDayTargets()[day];
  const input = await vscode.window.showInputBox({
    title: `Meta de ${formatDayLabel(day)}`,
    prompt: 'Horas que quieres cubrir ese día. Déjalo vacío para volver a la meta general.',
    placeHolder: 'Por ejemplo 4 o 4:30',
    value: current === undefined ? '' : String(current),
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim() === '' || parseTarget(value, 24) !== undefined
        ? undefined
        : 'Escribe unas horas entre 0 y 24, o déjalo vacío.',
  });
  if (input === undefined) {
    return;
  }

  const hours = input.trim() === '' ? undefined : parseTarget(input, 24);
  await writeDayTarget(day, hours);
  void vscode.window.showInformationMessage(
    hours === undefined
      ? `${formatDayLabel(day)} vuelve a la meta general.`
      : `Meta de ${formatDayLabel(day)}: ${formatHours(hours)}.`,
  );
}

/** El día al que apunta un nodo del árbol, sea una fila o la barra de hoy. */
function dayOf(node?: unknown): string | undefined {
  if (node instanceof HoursDayNode) {
    return node.summary.day;
  }
  if (node instanceof HoursBarNode) {
    return node.day;
  }
  return undefined;
}

function askDay(title = 'Festivo'): Thenable<string | undefined> {
  return vscode.window
    .showInputBox({
      title,
      prompt: 'Fecha, en formato AAAA-MM-DD',
      value: todayLocalDay(),
      ignoreFocusOut: true,
      validateInput: (value) =>
        parseIsoDay(value) ? undefined : 'Escribe una fecha válida, por ejemplo 2026-09-15.',
    })
    .then((value) => (value ? parseIsoDay(value) : undefined));
}
