const DAY_FORMATTER = new Intl.DateTimeFormat('es', { weekday: 'long', day: 'numeric', month: 'long' });
// Solo el mes: con `year` incluido, el español intercala un «de» («septiembre
// de 2026») que luego no hay forma limpia de recortar.
const MONTH_FORMATTER = new Intl.DateTimeFormat('es', { month: 'long' });

/** `YYYY-MM-DD` en hora local, sin pasar por UTC (toISOString movería los commits nocturnos). */
export function toLocalDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function todayLocalDay(): string {
  return toLocalDay(new Date());
}

/**
 * Valida una fecha escrita a mano en formato `YYYY-MM-DD`.
 *
 * Comprueba que el día exista de verdad: `new Date(2026, 1, 31)` normaliza a
 * marzo sin avisar, así que el formato correcto no basta.
 */
export function parseIsoDay(text: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) {
    return undefined;
  }
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day)
  ) {
    return undefined;
  }
  return `${year}-${month}-${day}`;
}

/** El día local de hace N días, `YYYY-MM-DD`. */
export function daysAgo(days: number, today = new Date()): string {
  return toLocalDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - days));
}

/**
 * `YYYY-MM` del día dado. Corte de cadena, no aritmética de fechas: `date` de
 * Odoo no lleva hora ni zona, así que el mes ya está escrito en el string.
 */
export function monthOf(day: string): string {
  return day.slice(0, 7);
}

/** El mes actual en hora local. */
export function currentMonth(): string {
  return monthOf(todayLocalDay());
}

/**
 * Primer y último día de un `YYYY-MM`, ambos inclusive.
 *
 * El día 0 del mes siguiente es el último del actual, así que los bisiestos
 * salen solos y no hace falta una tabla de días por mes.
 */
export function monthRange(month: string): { from: string; to: string } {
  const [year, index] = month.split('-').map(Number);
  const last = new Date(year, index, 0);
  return { from: `${month}-01`, to: toLocalDay(last) };
}

/** Todos los días entre `from` y `to`, ambos inclusive, en orden ascendente. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = shiftDay(day, 1)) {
    days.push(day);
  }
  return days;
}

/** 0 = domingo … 6 = sábado, en hora local. */
export function weekdayOf(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date).getDay();
}

/** «Septiembre». Sin el año: la vista solo muestra el mes en curso. */
export function formatMonthName(month: string): string {
  const [year, index] = month.split('-').map(Number);
  const label = MONTH_FORMATTER.format(new Date(year, index - 1, 1));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function shiftDay(day: string, delta: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return toLocalDay(new Date(year, month - 1, date + delta));
}

export function formatDayLabel(day: string): string {
  const today = todayLocalDay();
  if (day === today) {
    return 'Hoy';
  }
  if (day === shiftDay(today, -1)) {
    return 'Ayer';
  }
  const [year, month, date] = day.split('-').map(Number);
  const label = DAY_FORMATTER.format(new Date(year, month - 1, date));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Convierte el texto a horas decimales, sin juzgar el rango. Acepta `2.5`,
 * `2,5` y `2:30`. `undefined` si no es un número de horas.
 */
function readHours(input: string): number | undefined {
  const text = input.trim().replace(',', '.');
  if (!text) {
    return undefined;
  }

  const hoursMinutes = /^(\d{1,3}):([0-5]?\d)$/.exec(text);
  if (hoursMinutes) {
    return round2(Number(hoursMinutes[1]) + Number(hoursMinutes[2]) / 60);
  }

  const value = Number(text);
  return Number.isFinite(value) ? round2(value) : undefined;
}

/**
 * Horas de una imputación: `2.5`, `2,5` o `2:30`. Devuelve `undefined` si no es
 * una cantidad plausible, que es lo que `validateInput` usa para bloquear el
 * InputBox. Cero no vale: una línea de cero horas no tiene sentido.
 */
export function parseHours(input: string): number | undefined {
  const value = readHours(input);
  return value !== undefined && value > 0 && value <= 24 ? value : undefined;
}

/**
 * Horas de una meta. A diferencia de `parseHours` admite **cero**, que es como
 * se borra una meta, y llega hasta `max`, porque una meta mensual pasa de 24.
 */
export function parseTarget(input: string, max: number): number | undefined {
  const value = readHours(input);
  return value !== undefined && value >= 0 && value <= max ? value : undefined;
}

/** Redondeo a céntimos de hora. Lo comparten `parseHours` y el resumen mensual. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function formatHours(hours: number): string {
  // toFixed(2) garantiza que siempre haya punto decimal, así que quitar los
  // ceros de la derecha nunca puede comerse dígitos significativos.
  return `${hours.toFixed(2).replace(/\.?0+$/, '')} h`;
}

/**
 * Prefijo de fecha para el nombre de una tarea nueva, siguiendo la convención
 * que ya use el usuario en Odoo (`08/26 …`). Cadena vacía = sin prefijo.
 */
export function formatTaskDate(day: string, format: string): string {
  const [year, month, date] = day.split('-');
  switch (format) {
    case 'MM/DD':
      return `${month}/${date}`;
    case 'DD/MM':
      return `${date}/${month}`;
    case 'YYYY-MM-DD':
      return `${year}-${month}-${date}`;
    default:
      return '';
  }
}

/**
 * Texto completo de un commit para la descripción de la hoja de horas: el
 * subject más el cuerpo, si lo tiene, colapsado a una sola línea.
 *
 * El campo `name` de account.analytic.line es un Char sin `size=`, así que Odoo
 * no impone límite; el recorte es decisión nuestra y se aplica al final.
 */
export function joinCommitText(subject: string, body: string): string {
  const head = subject.trim();
  const tail = body.replace(/\s+/g, ' ').trim();
  if (!tail) {
    return head;
  }
  return head ? `${head} — ${tail}` : tail;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
