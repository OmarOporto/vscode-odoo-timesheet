/**
 * Resumen mensual de horas: agrega las líneas que vienen de Odoo en un total
 * por día y un total del mes, y los contrasta con la meta configurada.
 *
 * Como `lines.ts` y `registry.ts`, no importa `vscode`: así los tests pueden
 * empaquetarlo y ejecutarlo en Node puro, sin servidor ni editor.
 */
import { eachDay, monthOf, monthRange, round2, weekdayOf } from './util';

/** Una línea de hoja de horas, con los únicos dos campos que la vista necesita. */
export interface TimesheetRow {
  /** `YYYY-MM-DD`. Es un campo Date de Odoo: sin hora y sin zona horaria. */
  date: string;
  /** Horas decimales. Odoo guarda `unit_amount` siempre en horas. */
  unit_amount: number;
}

export interface DaySummary {
  day: string;
  hours: number;
  /** Cuántas líneas suman ese total. */
  lines: number;
  isWorkday: boolean;
  /** Marcado a mano como festivo. Los no laborables no cuentan como tal. */
  isHoliday: boolean;
  /** Tiene una meta propia escrita a mano, distinta de la general. */
  hasOwnTarget: boolean;
  /** Meta del día. `0` cuando no aplica: festivo, no laborable o meta desactivada. */
  target: number;
  deficit: number;
}

export interface MonthSummary {
  /** `YYYY-MM`. */
  month: string;
  /** Del más reciente al más antiguo. */
  days: DaySummary[];
  /**
   * El día de hoy, esté o no en `days`: un domingo sin horas o una meta diaria
   * de cero lo dejan fuera de la lista, pero la barra de hoy lo necesita igual.
   */
  today: DaySummary;
  hours: number;
  /** Suma de las metas de los días transcurridos. */
  expected: number;
  /** Suma de las metas del mes entero. */
  expectedFullMonth: number;
  /** Contra qué se mide la barra del mes: la meta escrita a mano, o la calculada. */
  monthTarget: number;
  deficit: number;
  lineCount: number;
  /** Se alcanzó el tope de líneas: el total puede estar incompleto. */
  truncated: boolean;
}

export interface HoursOptions {
  /** `0` desactiva la meta y con ella todas las marcas. */
  dailyTarget: number;
  /** Días de la semana laborables: 0 = domingo … 6 = sábado. */
  workdays: number[];
  /** Festivos marcados a mano, `YYYY-MM-DD`. No se les exige meta. */
  holidays: string[];
  /**
   * Metas para días sueltos, `YYYY-MM-DD` → horas. Mandan sobre todo lo demás,
   * incluidos festivos y no laborables: si le pones meta a un domingo es porque
   * ese domingo trabajas.
   */
  dayTargets: Record<string, number>;
  /** Meta del mes escrita a mano. `0` = la calculada a partir de la diaria. */
  monthlyTarget: number;
  /** El `limit` que se pasó a Odoo, para poder detectar el truncamiento. */
  limit: number;
}

/** Ancho por defecto de las barras. Suficiente para leerlas en un panel estrecho. */
const BAR_WIDTH = 10;

/**
 * Barra de progreso con bloques. Sin meta no hay nada que medir, así que
 * `target <= 0` devuelve cadena vacía y quien llama decide qué poner en su sitio.
 */
export function progressBar(done: number, target: number, width = BAR_WIDTH): string {
  if (target <= 0) {
    return '';
  }
  const ratio = Math.min(1, Math.max(0, done / target));
  let filled = Math.round(ratio * width);
  // Con Math.round a secas, media hora de ocho daria cero bloques y la barra
  // diria «no has hecho nada». Algo hecho siempre se ve.
  if (filled === 0 && done > 0) {
    filled = 1;
  }
  // Y al reves: no llenarla del todo hasta que la meta este cumplida de verdad.
  if (filled === width && done < target) {
    filled = width - 1;
  }
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/**
 * Agrega las filas del mes al que pertenece `today`.
 *
 * `today` entra por parámetro en vez de leerse aquí dentro: es lo que hace la
 * función determinista y testeable sin congelar el reloj, igual que el
 * `today = new Date()` de `daysAgo`.
 *
 * Con meta, aparecen todos los días laborables ya transcurridos **incluidos los
 * que están a cero**: son justo los que hay que ver. Cualquier otro día aparece
 * solo si tiene horas, los futuros incluidos — imputar por adelantado es raro
 * pero legal, y un total del mes que no cuadrase con los días listados sería
 * peor que una fila de más.
 */
export function summarizeMonth(
  rows: TimesheetRow[],
  today: string,
  options: HoursOptions,
): MonthSummary {
  const month = monthOf(today);
  const { from, to } = monthRange(month);

  // `unit_amount ?? 0` porque Odoo puede devolver el campo ausente, igual que
  // ya asume el agregado de diagnostics.ts.
  const totals = new Map<string, { hours: number; lines: number }>();
  let lineCount = 0;
  for (const row of rows) {
    if (row.date < from || row.date > to) {
      continue;
    }
    const entry = totals.get(row.date) ?? { hours: 0, lines: 0 };
    entry.hours += row.unit_amount ?? 0;
    entry.lines += 1;
    totals.set(row.date, entry);
    lineCount += 1;
  }

  const holidays = new Set(options.holidays);
  const isWorkday = (day: string): boolean => options.workdays.includes(weekdayOf(day));
  // Un festivo y un día no laborable se tratan igual: ninguno reclama horas.
  const counts = (day: string): boolean => isWorkday(day) && !holidays.has(day);
  const hasOwnTarget = (day: string): boolean =>
    Object.prototype.hasOwnProperty.call(options.dayTargets, day);

  /** Lo que el día pide, haya llegado o no. La excepción manda sobre todo. */
  const plannedTarget = (day: string): number =>
    hasOwnTarget(day) ? options.dayTargets[day] : counts(day) ? options.dailyTarget : 0;

  // Un día que aún no ha llegado no debe nada: marcarlo como incompleto sería
  // reprochar trabajo no hecho todavía.
  const targetOf = (day: string): number => (day <= today ? plannedTarget(day) : 0);

  const summarize = (day: string): DaySummary => {
    const entry = totals.get(day);
    const target = targetOf(day);
    const hours = round2(entry?.hours ?? 0);
    return {
      day,
      hours,
      lines: entry?.lines ?? 0,
      isWorkday: isWorkday(day),
      isHoliday: holidays.has(day),
      hasOwnTarget: hasOwnTarget(day),
      target,
      deficit: round2(Math.max(0, target - hours)),
    };
  };

  const days: DaySummary[] = [];
  for (const day of eachDay(from, to)) {
    const summary = summarize(day);
    // Un día vacío solo aporta cuando hay meta que incumplir, o cuando lo
    // tocaste tú: si un festivo o una meta propia desaparecieran de la lista,
    // no habría forma de quitarlos.
    const marked = (summary.isHoliday || summary.hasOwnTarget) && day <= today;
    if (summary.lines === 0 && summary.target === 0 && !marked) {
      continue;
    }
    days.push(summary);
  }
  days.reverse();

  // El total sale de las filas y no de la suma de los días redondeados: de otro
  // modo el redondeo se aplicaría dos veces y el mes acumularía el error.
  const hours = round2([...totals.values()].reduce((sum, entry) => sum + entry.hours, 0));
  // Sumar metas en vez de contar días × meta diaria: así las excepciones por día
  // entran solas, y los festivos siguen saliendo de lo esperado — si no, el mes
  // arrastraría un déficit que nadie puede cubrir.
  const sumTargets = (until: string): number =>
    round2(eachDay(from, until).reduce((sum, day) => sum + plannedTarget(day), 0));

  const expected = sumTargets(today < to ? today : to);
  const expectedFullMonth = sumTargets(to);

  return {
    month,
    days,
    today: summarize(today),
    hours,
    expected,
    expectedFullMonth,
    monthTarget: options.monthlyTarget > 0 ? options.monthlyTarget : expectedFullMonth,
    deficit: round2(Math.max(0, expected - hours)),
    lineCount,
    truncated: rows.length >= options.limit,
  };
}
