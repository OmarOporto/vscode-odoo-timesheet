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
  /** Meta del día. `0` cuando no aplica: festivo, no laborable o meta desactivada. */
  target: number;
  deficit: number;
}

export interface MonthSummary {
  /** `YYYY-MM`. */
  month: string;
  /** Del más reciente al más antiguo. */
  days: DaySummary[];
  hours: number;
  /** Laborables transcurridos × meta diaria. */
  expected: number;
  /** El mes entero, para el tooltip. */
  expectedFullMonth: number;
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
  /** El `limit` que se pasó a Odoo, para poder detectar el truncamiento. */
  limit: number;
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
  // Un día que aún no ha llegado tampoco tiene meta: marcarlo como incompleto
  // sería reprochar trabajo no hecho todavía.
  const targetOf = (day: string): number =>
    counts(day) && day <= today ? options.dailyTarget : 0;

  const days: DaySummary[] = [];
  for (const day of eachDay(from, to)) {
    const entry = totals.get(day);
    const target = targetOf(day);
    const isHoliday = holidays.has(day);
    // Un día vacío solo aporta cuando hay meta que incumplir, o cuando lo
    // marcaste tú: si un festivo desapareciera, no habría forma de desmarcarlo.
    if (!entry && target === 0 && !(isHoliday && day <= today)) {
      continue;
    }
    const hours = round2(entry?.hours ?? 0);
    days.push({
      day,
      hours,
      lines: entry?.lines ?? 0,
      isWorkday: isWorkday(day),
      isHoliday,
      target,
      deficit: round2(Math.max(0, target - hours)),
    });
  }
  days.reverse();

  // El total sale de las filas y no de la suma de los días redondeados: de otro
  // modo el redondeo se aplicaría dos veces y el mes acumularía el error.
  const hours = round2([...totals.values()].reduce((sum, entry) => sum + entry.hours, 0));
  // Los festivos salen de lo esperado, no solo de las marcas: si no, el mes
  // arrastraría un déficit que nadie puede cubrir.
  const expected = round2(
    eachDay(from, today < to ? today : to).filter(counts).length * options.dailyTarget,
  );
  const expectedFullMonth = round2(
    eachDay(from, to).filter(counts).length * options.dailyTarget,
  );

  return {
    month,
    days,
    hours,
    expected,
    expectedFullMonth,
    deficit: round2(Math.max(0, expected - hours)),
    lineCount,
    truncated: rows.length >= options.limit,
  };
}
