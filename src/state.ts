import * as vscode from 'vscode';
import { OdooClient, OdooError, type ApiPreference, type OdooCredentials } from './odoo/client';
import { detectSchema, type OdooSchema } from './odoo/schema';
import { resolveEmployeeId } from './odoo/timesheets';
import { parseIsoDay } from './util';

const SECRET_KEY = 'odooTimesheet.password';
const GLOBAL = vscode.ConfigurationTarget.Global;

export interface OdooConnection {
  client: OdooClient;
  schema: OdooSchema;
}

export interface OdooSettings extends Omit<OdooCredentials, 'password'> {
  api: ApiPreference;
}

/** Lee la parte no secreta de la configuración. La contraseña vive en SecretStorage. */
export function readSettings(): OdooSettings {
  const config = vscode.workspace.getConfiguration('odooTimesheet');
  return {
    url: (config.get<string>('url') ?? '').trim(),
    db: (config.get<string>('db') ?? '').trim(),
    username: (config.get<string>('username') ?? '').trim(),
    allowInsecureTLS: config.get<boolean>('allowInsecureTLS', false),
    api: config.get<ApiPreference>('api', 'auto'),
  };
}

export interface PinnedProject {
  id: number;
  name: string;
}

/** El proyecto fijado vive en `settings.json` para que se pueda editar a mano. */
export function readPinnedProject(): PinnedProject | undefined {
  const config = vscode.workspace.getConfiguration('odooTimesheet');
  const id = config.get<number>('projectId', 0);
  if (!id || id <= 0) {
    return undefined;
  }
  return { id, name: (config.get<string>('projectName') ?? '').trim() || `#${id}` };
}

export async function writePinnedProject(project: PinnedProject | undefined): Promise<void> {
  const config = vscode.workspace.getConfiguration('odooTimesheet');
  await config.update('projectId', project?.id ?? 0, GLOBAL);
  await config.update('projectName', project?.name ?? '', GLOBAL);
  await vscode.commands.executeCommand(
    'setContext',
    'odooTimesheet.projectPinned',
    project !== undefined,
  );
}

/**
 * Los festivos también viven en `settings.json`: se marcan desde la vista, pero
 * hay que poder pegar el calendario del año de una vez, y que viajen con la
 * sincronización de ajustes.
 */
export function readHolidays(): string[] {
  const days = vscode.workspace.getConfiguration('odooTimesheet').get<string[]>('hoursHolidays', []);
  // Filtrado defensivo: esto lo edita gente a mano y una fecha mal escrita no
  // debe descuadrar el mes en silencio.
  return days.map((day) => parseIsoDay(String(day))).filter((day): day is string => Boolean(day));
}

/** Añade o quita un día de la lista, siempre ordenada y sin repetidos. */
export async function toggleHoliday(day: string): Promise<boolean> {
  const current = new Set(readHolidays());
  const isHoliday = !current.has(day);
  if (isHoliday) {
    current.add(day);
  } else {
    current.delete(day);
  }
  await vscode.workspace
    .getConfiguration('odooTimesheet')
    .update('hoursHolidays', [...current].sort(), GLOBAL);
  return isHoliday;
}

/**
 * Metas para días sueltos. Mismo filtrado defensivo que `readHolidays`: se
 * edita a mano y una fecha o un número mal escritos no deben descuadrar el mes
 * en silencio.
 */
export function readDayTargets(): Record<string, number> {
  const raw = vscode.workspace
    .getConfiguration('odooTimesheet')
    .get<Record<string, unknown>>('hoursDayTargets', {});
  const targets: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    const day = parseIsoDay(String(key));
    const hours = Number(value);
    if (day && Number.isFinite(hours) && hours >= 0 && hours <= 24) {
      targets[day] = hours;
    }
  }
  return targets;
}

/** `undefined` borra la excepción y devuelve el día a la meta general. */
export async function writeDayTarget(day: string, hours: number | undefined): Promise<void> {
  const targets = readDayTargets();
  if (hours === undefined) {
    delete targets[day];
  } else {
    targets[day] = hours;
  }
  // Ordenado por fecha: esto se acaba leyendo a mano en settings.json.
  const sorted = Object.fromEntries(Object.entries(targets).sort(([a], [b]) => a.localeCompare(b)));
  await vscode.workspace.getConfiguration('odooTimesheet').update('hoursDayTargets', sorted, GLOBAL);
}

export class OdooSession implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  private current: OdooConnection | undefined;
  private employeeId: number | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  get connection(): OdooConnection | undefined {
    return this.current;
  }

  get isConnected(): boolean {
    return this.current !== undefined;
  }

  requireConnection(): OdooConnection {
    if (!this.current) {
      throw new OdooError('No hay conexión con Odoo. Ejecuta «Odoo: Conectar a Odoo».', 'auth');
    }
    return this.current;
  }

  storePassword(password: string): Thenable<void> {
    return this.context.secrets.store(SECRET_KEY, password);
  }

  readPassword(): Thenable<string | undefined> {
    return this.context.secrets.get(SECRET_KEY);
  }

  clearPassword(): Thenable<void> {
    return this.context.secrets.delete(SECRET_KEY);
  }

  async connect(credentials: OdooCredentials, api: ApiPreference): Promise<OdooConnection> {
    const client = await OdooClient.connect(credentials, api, (message) => this.log.debug(message));
    const schema = await detectSchema(client, (message) => this.log.warn(message));

    this.current = { client, schema };
    this.employeeId = undefined;
    await setConnectedContext(true);
    this.emitter.fire();

    this.log.info(
      `Conectado a ${client.url} · transporte ${client.api} · db «${client.db ?? '(no aplica)'}» · ` +
        `usuario ${client.login} (uid ${client.userId}) · Odoo ${schema.serverVersion} · ` +
        `campo de asignado «${schema.assigneeField}»`,
    );
    return this.current;
  }

  async disconnect(): Promise<void> {
    this.current = undefined;
    this.employeeId = undefined;
    await setConnectedContext(false);
    this.emitter.fire();
    this.log.info('Sesión de Odoo cerrada.');
  }

  /** Reconecta al arrancar si ya hay credenciales guardadas. Falla en silencio. */
  async restore(): Promise<void> {
    const settings = readSettings();
    await vscode.commands.executeCommand(
      'setContext',
      'odooTimesheet.projectPinned',
      readPinnedProject() !== undefined,
    );

    if (!settings.url) {
      return;
    }
    const password = await this.readPassword();
    if (!password) {
      return;
    }
    try {
      await this.connect({ ...settings, password }, settings.api);
    } catch (error) {
      this.log.warn(
        `No se pudo restaurar la sesión de Odoo: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getEmployeeId(): Promise<number> {
    if (this.employeeId !== undefined) {
      return this.employeeId;
    }
    const { client } = this.requireConnection();
    this.employeeId = await resolveEmployeeId(client);
    this.log.info(`Empleado de Odoo resuelto: id ${this.employeeId}`);
    return this.employeeId;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function setConnectedContext(connected: boolean): Thenable<unknown> {
  return vscode.commands.executeCommand('setContext', 'odooTimesheet.connected', connected);
}
