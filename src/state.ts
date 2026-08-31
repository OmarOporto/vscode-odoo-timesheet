import * as vscode from 'vscode';
import { OdooClient, OdooError, type OdooCredentials } from './odoo/client';
import { detectSchema, type OdooSchema } from './odoo/schema';
import { resolveEmployeeId } from './odoo/timesheets';

const SECRET_KEY = 'odooTimesheet.password';

export interface OdooConnection {
  client: OdooClient;
  schema: OdooSchema;
}

/** Lee la parte no secreta de la configuración. La contraseña vive en SecretStorage. */
export function readSettings(): Omit<OdooCredentials, 'password'> {
  const config = vscode.workspace.getConfiguration('odooTimesheet');
  return {
    url: (config.get<string>('url') ?? '').trim(),
    db: (config.get<string>('db') ?? '').trim(),
    username: (config.get<string>('username') ?? '').trim(),
    allowInsecureTLS: config.get<boolean>('allowInsecureTLS', false),
  };
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

  async connect(credentials: OdooCredentials): Promise<OdooConnection> {
    const client = new OdooClient(credentials, (message) => this.log.debug(message));
    await client.authenticate();
    const schema = await detectSchema(client, (message) => this.log.warn(message));

    this.current = { client, schema };
    this.employeeId = undefined;
    await setConnectedContext(true);
    this.emitter.fire();

    this.log.info(
      `Conectado a ${client.url} · db «${client.db}» · usuario ${client.login} (uid ${client.userId}) · ` +
        `Odoo ${schema.serverVersion} · campo de asignado «${schema.assigneeField}»`,
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
    if (!settings.url || !settings.db || !settings.username) {
      return;
    }
    const password = await this.readPassword();
    if (!password) {
      return;
    }
    try {
      await this.connect({ ...settings, password });
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
