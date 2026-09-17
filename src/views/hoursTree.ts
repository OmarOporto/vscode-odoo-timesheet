import * as vscode from 'vscode';
import {
  progressBar,
  summarizeMonth,
  type DaySummary,
  type HoursOptions,
  type MonthSummary,
  type TimesheetRow,
} from '../hours';
import { fetchTimesheetLines } from '../odoo/timesheets';
import { readDayTargets, readHolidays, type OdooSession } from '../state';
import { dayUri } from './hoursDecorations';
import {
  currentMonth,
  formatDayLabel,
  formatHours,
  formatMonthName,
  monthRange,
  pluralize,
  todayLocalDay,
} from '../util';

/** Tope de líneas por consulta. Un mes de una persona son decenas: es un seguro. */
const LINE_LIMIT = 500;

/**
 * Una de las dos barras de progreso. `day` solo lo lleva la de hoy, y es lo que
 * permite colgarle el botón de editar la meta de ese día.
 */
export class HoursBarNode {
  constructor(
    readonly kind: 'month' | 'today',
    readonly done: number,
    readonly target: number,
    readonly caption: string,
    readonly day?: string,
  ) {}
}

/** El grupo plegable. Plegarlo deja la vista en las dos barras. */
export class HoursDaysNode {
  constructor(
    readonly shown: number,
    readonly total: number,
  ) {}
}

export class HoursMoreNode {
  constructor(readonly shown: number) {}
}

export class HoursDayNode {
  constructor(readonly summary: DaySummary) {}
}

export class HoursInfoNode {
  constructor(
    readonly label: string,
    readonly icon: string,
  ) {}
}

export type HoursTreeNode =
  | HoursBarNode
  | HoursDaysNode
  | HoursMoreNode
  | HoursDayNode
  | HoursInfoNode;

export class HoursTreeProvider implements vscode.TreeDataProvider<HoursTreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<HoursTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly disposables: vscode.Disposable[] = [];
  private rows: TimesheetRow[] = [];
  /** El mes al que corresponden las filas en caché. */
  private cachedMonth: string | undefined;
  private loadError: string | undefined;
  /**
   * La cabecera y el árbol piden los datos a la vez tras cada `fire()`. Sin
   * compartir la consulta en vuelo, cada refresco serían dos viajes a Odoo.
   */
  private inFlight: Promise<void> | undefined;
  /** Días visibles. Solo en memoria, como el `pageSizes` de la vista de tareas. */
  private pageSize: number | undefined;

  constructor(
    private readonly session: OdooSession,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.disposables.push(
      session.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        // La meta solo cambia cómo se pinta lo que ya tenemos: repintar basta.
        // Volver a Odoo por mover un número en los ajustes sería gratuito.
        if (
          event.affectsConfiguration('odooTimesheet.hoursDailyTarget') ||
          event.affectsConfiguration('odooTimesheet.hoursWorkdays') ||
          event.affectsConfiguration('odooTimesheet.hoursHolidays') ||
          event.affectsConfiguration('odooTimesheet.hoursDayTargets') ||
          event.affectsConfiguration('odooTimesheet.hoursMonthlyTarget') ||
          event.affectsConfiguration('odooTimesheet.hoursDaysShown')
        ) {
          this.redraw();
        }
      }),
    );
  }

  /** Invalida la caché: la próxima lectura vuelve a consultar Odoo. */
  refresh(): void {
    this.cachedMonth = undefined;
    this.loadError = undefined;
    this.pageSize = undefined;
    this.emitter.fire();
  }

  /** Repinta con las filas que ya están en memoria. */
  redraw(): void {
    this.emitter.fire();
  }

  /** Amplía la lista de días en un paso más. */
  showMore(node: HoursMoreNode): void {
    this.pageSize = node.shown + basePageSize();
    this.emitter.fire();
  }

  /** Para la cabecera de la vista: el dato que no debería obligar a leer la lista. */
  async describeMonth(): Promise<string | undefined> {
    if (!this.session.connection) {
      return undefined;
    }
    const summary = await this.load();
    if (!summary) {
      return undefined;
    }
    // Sin el año: la cabecera es estrecha y siempre es el mes en curso. Y
    // contra el mes entero, igual que la barra: dos cifras distintas para lo
    // mismo, una arriba y otra dos líneas más abajo, serían un acertijo.
    const month = formatMonthName(summary.month);
    return summary.monthTarget > 0
      ? `${month} · ${amount(summary.hours)} / ${formatHours(summary.monthTarget)}`
      : `${month} · ${formatHours(summary.hours)}`;
  }

  getTreeItem(element: HoursTreeNode): vscode.TreeItem {
    if (element instanceof HoursBarNode) {
      const bar = progressBar(element.done, element.target);
      // La barra va en la etiqueta y no en la descripción, que VS Code pinta
      // atenuada: es el dato que hay que ver de un vistazo. «Mes» y «Hoy» miden
      // lo mismo, así que las dos barras quedan alineadas.
      const item = new vscode.TreeItem(
        bar ? `${element.caption}  ${bar}` : element.caption,
        vscode.TreeItemCollapsibleState.None,
      );
      item.id = `hours:bar:${element.kind}`;
      item.contextValue = element.kind === 'month' ? 'hoursMonthBar' : 'hoursTodayBar';
      item.iconPath = new vscode.ThemeIcon(element.kind === 'month' ? 'calendar' : 'clock');

      if (element.target > 0) {
        const left = Math.max(0, element.target - element.done);
        item.description =
          left > 0
            ? `${amount(element.done)} / ${formatHours(element.target)} · faltan ${amount(left)}`
            : `${amount(element.done)} / ${formatHours(element.target)} · cumplida`;
      } else {
        item.description = formatHours(element.done);
      }
      return item;
    }

    if (element instanceof HoursDaysNode) {
      const item = new vscode.TreeItem(
        'Días',
        vscode.TreeItemCollapsibleState.Expanded,
      );
      // Id fijo: si cambiara entre repintados, VS Code perdería el plegado y la
      // vista se volvería a desplegar sola cada vez que se refresca.
      item.id = 'hours:days';
      item.description =
        element.shown < element.total ? `${element.shown} de ${element.total}` : `${element.total}`;
      item.contextValue = 'hoursDays';
      item.iconPath = new vscode.ThemeIcon('list-flat');
      return item;
    }

    if (element instanceof HoursMoreNode) {
      const item = new vscode.TreeItem('Mostrar más…', vscode.TreeItemCollapsibleState.None);
      // El id lleva cuántos se muestran para que VS Code no reutilice el nodo
      // anterior al ampliar la página.
      item.id = `hours:more:${element.shown}`;
      item.description = `${element.shown} mostrados`;
      item.contextValue = 'hoursMore';
      item.iconPath = new vscode.ThemeIcon('ellipsis');
      item.command = {
        command: 'odooTimesheet.showMoreHours',
        title: 'Mostrar más',
        arguments: [element],
      };
      return item;
    }

    if (element instanceof HoursDayNode) {
      const day = element.summary;
      const item = new vscode.TreeItem(
        formatDayLabel(day.day),
        vscode.TreeItemCollapsibleState.None,
      );
      item.id = `hours:${day.day}`;
      item.description = day.lines > 0 ? formatHours(day.hours) : '—';
      // Dos valores distintos para que el menú ofrezca «marcar» o «quitar», no
      // ambos. El prefijo `hours` evita los menús de commits, que filtran por
      // `viewItem =~ /^commit/` sin acotar la vista.
      item.contextValue = day.isHoliday ? 'hoursDayHoliday' : 'hoursDay';
      item.iconPath = dayIcon(day);
      // El color de la fila lo pone HolidayDecorations a través de esta URI.
      item.resourceUri = dayUri(day.day);

      // appendText y no appendMarkdown: aquí no hay texto de terceros, pero el
      // resto de las vistas lo hace así y no merece la pena la excepción.
      const tooltip = new vscode.MarkdownString();
      tooltip.appendText(`${day.day}\n`);
      tooltip.appendText(`${formatHours(day.hours)} en ${pluralize(day.lines, 'línea', 'líneas')}\n`);
      if (day.target > 0) {
        tooltip.appendText(
          day.deficit > 0
            ? `Meta ${formatHours(day.target)} · faltan ${formatHours(day.deficit)}`
            : `Meta ${formatHours(day.target)} · cumplida`,
        );
        if (day.hasOwnTarget) {
          tooltip.appendText(' (meta propia de este día)');
        }
      } else if (day.hasOwnTarget) {
        tooltip.appendText('Meta propia de 0 h: no cuenta para la meta');
      } else if (day.isHoliday) {
        tooltip.appendText('Festivo: no cuenta para la meta');
      } else if (!day.isWorkday) {
        tooltip.appendText('Día no laborable: no cuenta para la meta');
      }
      item.tooltip = tooltip;
      return item;
    }

    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(element.icon);
    item.contextValue = 'info';
    return item;
  }

  async getChildren(element?: HoursTreeNode): Promise<HoursTreeNode[]> {
    // Solo el grupo de días tiene hijos; el resto son hojas.
    if (element && !(element instanceof HoursDaysNode)) {
      return [];
    }
    if (!this.session.connection) {
      // La vista de bienvenida ofrece el botón de conectar.
      return [];
    }

    const summary = await this.load();
    if (this.loadError) {
      return element ? [] : [new HoursInfoNode(this.loadError, 'error')];
    }
    if (!summary) {
      return [];
    }

    return element ? this.dayNodes(summary) : this.rootNodes(summary);
  }

  private rootNodes(summary: MonthSummary): HoursTreeNode[] {
    const today = summary.today;
    const nodes: HoursTreeNode[] = [
      new HoursBarNode('month', summary.hours, summary.monthTarget, 'Mes'),
      new HoursBarNode('today', today.hours, today.target, 'Hoy', today.day),
    ];

    if (summary.days.length === 0) {
      nodes.push(new HoursInfoNode('Sin horas registradas este mes', 'info'));
    } else {
      nodes.push(new HoursDaysNode(this.visibleCount(summary), summary.days.length));
    }

    if (summary.truncated) {
      // Un total incompleto sin avisar es peor que no tener total.
      nodes.push(
        new HoursInfoNode(
          `Se alcanzó el tope de ${LINE_LIMIT} líneas: el total puede estar incompleto`,
          'warning',
        ),
      );
    }
    return nodes;
  }

  private dayNodes(summary: MonthSummary): HoursTreeNode[] {
    const shown = this.visibleCount(summary);
    const nodes: HoursTreeNode[] = summary.days
      .slice(0, shown)
      .map((day) => new HoursDayNode(day));
    if (shown < summary.days.length) {
      nodes.push(new HoursMoreNode(shown));
    }
    return nodes;
  }

  private visibleCount(summary: MonthSummary): number {
    return Math.min(this.pageSize ?? basePageSize(), summary.days.length);
  }

  /**
   * Lee el mes en curso, con caché.
   *
   * La caché se invalida sola al cambiar de mes: sin eso, una ventana abierta
   * desde el día 30 seguiría enseñando el mes anterior.
   */
  private async load(): Promise<MonthSummary | undefined> {
    const today = todayLocalDay();
    const month = currentMonth();
    const options = readHoursOptions();

    if (this.cachedMonth !== month) {
      this.inFlight ??= this.fetch(month);
      await this.inFlight;
    }
    if (this.loadError || this.cachedMonth !== month) {
      return undefined;
    }

    return summarizeMonth(this.rows, today, { ...options, limit: LINE_LIMIT });
  }

  private async fetch(month: string): Promise<void> {
    try {
      const connection = this.session.connection;
      if (!connection) {
        return;
      }
      const { from, to } = monthRange(month);
      this.rows = await fetchTimesheetLines(connection.client, from, to, LINE_LIMIT);
      this.cachedMonth = month;
      this.loadError = undefined;

      // Una traza por consulta, no por repintado: así el registro también sirve
      // para comprobar que cambiar la meta no vuelve a pegarle a Odoo.
      const summary = summarizeMonth(this.rows, todayLocalDay(), {
        ...readHoursOptions(),
        limit: LINE_LIMIT,
      });
      this.log.info(
        `Horas de ${month}: ${formatHours(summary.hours)} en ${pluralize(summary.lineCount, 'línea', 'líneas')} · ` +
          `esperadas ${formatHours(summary.expected)} a día de hoy, ${formatHours(summary.expectedFullMonth)} el mes entero`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`Error cargando las horas del mes: ${message}`);
      this.loadError = message;
    } finally {
      this.inFlight = undefined;
    }
  }

  dispose(): void {
    this.emitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

/** Las horas sin la unidad, para no repetir «h» en `84.5 / 96 h`. */
function amount(hours: number): string {
  return formatHours(hours).replace(/ h$/, '');
}

function readHoursOptions(): Omit<HoursOptions, 'limit'> {
  const config = vscode.workspace.getConfiguration('odooTimesheet');
  return {
    dailyTarget: config.get<number>('hoursDailyTarget', 8),
    workdays: config.get<number[]>('hoursWorkdays', [1, 2, 3, 4, 5, 6]),
    holidays: readHolidays(),
    dayTargets: readDayTargets(),
    monthlyTarget: config.get<number>('hoursMonthlyTarget', 0),
  };
}

function basePageSize(): number {
  return vscode.workspace.getConfiguration('odooTimesheet').get<number>('hoursDaysShown', 5);
}

/**
 * `ThemeColor` y no un color literal: el icono tiene que seguir funcionando en
 * los temas claros, en los oscuros y en los de alto contraste.
 */
function dayIcon(day: DaySummary): vscode.ThemeIcon {
  // El mismo gris que HolidayDecorations le da a la etiqueta: la decoración
  // solo llega al texto, el icono hay que teñirlo aparte.
  const muted = new vscode.ThemeColor('gitDecoration.ignoredResourceForeground');
  if (day.isHoliday) {
    return new vscode.ThemeIcon('calendar', muted);
  }
  if (day.target === 0) {
    return new vscode.ThemeIcon('clock', muted);
  }
  return day.deficit > 0
    ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
    : new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
}
