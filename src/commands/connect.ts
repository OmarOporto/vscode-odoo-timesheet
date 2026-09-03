import * as vscode from 'vscode';
import {
  MISSING_DB,
  MISSING_USERNAME,
  normalizeBaseUrl,
  OdooClient,
  OdooError,
} from '../odoo/client';
import { listProjects, searchTasks } from '../odoo/tasks';
import { readSettings, type OdooSession } from '../state';

const GLOBAL = vscode.ConfigurationTarget.Global;

/**
 * Datos del proceso en marcha. Importa sobre todo la versión: una ventana
 * abierta desde antes de actualizar sigue ejecutando el código viejo, y sin
 * esto no hay forma de distinguirlo de un fallo de la extensión.
 */
export interface RuntimeInfo {
  version: string;
  /** `local`, `wsl`, `ssh-remote`… */
  host: string;
  marks: number;
}

export type RuntimeInfoProvider = () => RuntimeInfo;

/**
 * Flujo de conexión.
 *
 * Con JSON-2 basta la URL y una API key: la propia key identifica al usuario y
 * la base de datos. La base y el usuario solo se piden cuando hay que caer al
 * transporte antiguo, que sí los necesita — el transporte lo señala con los
 * marcadores MISSING_DB / MISSING_USERNAME.
 */
export async function connectCommand(
  session: OdooSession,
  log: vscode.LogOutputChannel,
): Promise<void> {
  const config = vscode.workspace.getConfiguration('odooTimesheet');
  const settings = readSettings();

  const url = settings.url || (await askUrl());
  if (!url) {
    return;
  }
  if (url !== settings.url) {
    await config.update('url', url, GLOBAL);
  }

  let password = await session.readPassword();
  let db = settings.db;
  let username = settings.username;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!password) {
      password = await askPassword();
      if (!password) {
        return;
      }
    }

    try {
      const connection = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Conectando a ${url}…` },
        () =>
          session.connect(
            { url, db, username, password: password as string, allowInsecureTLS: settings.allowInsecureTLS },
            settings.api,
          ),
      );

      await session.storePassword(password);
      // Con JSON-2 el login lo descubre el servidor: se guarda para que la
      // configuración quede legible y para una eventual caída a JSON-RPC.
      if (connection.client.login && connection.client.login !== username) {
        await config.update('username', connection.client.login, GLOBAL);
      }

      void vscode.window.showInformationMessage(
        `Conectado a Odoo ${connection.schema.serverVersion} como ${connection.client.login} (API ${connection.client.api}).`,
      );
      return;
    } catch (error) {
      const odooError = error instanceof OdooError ? error : undefined;
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Fallo al conectar: ${message}`);

      if (odooError?.detail === MISSING_DB) {
        const resolved = await resolveDatabase(url, settings.allowInsecureTLS, log);
        if (!resolved) {
          return;
        }
        db = resolved;
        await config.update('db', db, GLOBAL);
        continue;
      }

      if (odooError?.detail === MISSING_USERNAME) {
        const resolved = await askUsername();
        if (!resolved) {
          return;
        }
        username = resolved;
        await config.update('username', username, GLOBAL);
        continue;
      }

      if (odooError?.kind === 'auth' && attempt < 3) {
        await session.clearPassword();
        password = undefined;
        const retry = await vscode.window.showErrorMessage(message, 'Reintentar');
        if (retry !== 'Reintentar') {
          return;
        }
        continue;
      }

      void vscode.window.showErrorMessage(message, 'Ver registro').then((action) => {
        if (action) {
          log.show();
        }
      });
      return;
    }
  }
}

export async function disconnectCommand(session: OdooSession): Promise<void> {
  await session.disconnect();
  const action = await vscode.window.showInformationMessage(
    'Sesión de Odoo cerrada. ¿Quieres olvidar también la contraseña guardada?',
    'Olvidar contraseña',
    'Conservarla',
  );
  if (action === 'Olvidar contraseña') {
    await session.clearPassword();
  }
}

/** SecretStorage no se puede editar a mano: esta es la única vía de cambiarla. */
export async function changePasswordCommand(
  session: OdooSession,
  log: vscode.LogOutputChannel,
): Promise<void> {
  const password = await askPassword();
  if (!password) {
    return;
  }
  await session.storePassword(password);
  await session.disconnect();
  await connectCommand(session, log);
}

export async function testConnectionCommand(
  session: OdooSession,
  log: vscode.LogOutputChannel,
  runtime: RuntimeInfoProvider,
): Promise<void> {
  logConfiguration(log, runtime);

  if (!session.isConnected) {
    log.warn('Sin conexión activa: se abrirá el flujo de conexión.');
    log.show();
    await connectCommand(session, log);
    return;
  }

  const { client, schema } = session.requireConnection();
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Probando la conexión con Odoo…' },
      async () => {
        const tasks = await searchTasks(client, schema, { scope: 'assigned', limit: 1 });
        const projects = await listProjects(client, schema, { limit: 5 });
        const employeeId = await session.getEmployeeId();

        log.info(
          [
            'Prueba de conexión correcta:',
            `  URL            ${client.url}`,
            `  Transporte     ${client.api}`,
            `  Base de datos  ${client.db ?? '(no aplica en JSON-2)'}`,
            `  Usuario        ${client.login} (uid ${client.userId})`,
            `  Versión        ${schema.serverVersion} (mayor ${schema.majorVersion})`,
            `  Asignado       ${schema.assigneeField}`,
            `  Empleado       id ${employeeId}`,
            `  Proyectos      ${projects.length} legibles`,
            `  Tareas         ${tasks.length > 0 ? 'lectura correcta' : 'sin tareas asignadas'}`,
          ].join('\n'),
        );

        void vscode.window
          .showInformationMessage(
            `Odoo ${schema.serverVersion} vía ${client.api} · uid ${client.userId} · empleado ${employeeId}.`,
            'Ver detalles',
          )
          .then((action) => {
            if (action) {
              log.show();
            }
          });
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Prueba de conexión fallida: ${message}`);
    void vscode.window.showErrorMessage(message, 'Ver registro').then((action) => {
      if (action) {
        log.show();
      }
    });
  }
}

/**
 * Vuelca la configuración resuelta y **de qué ámbito viene cada valor**, que es
 * justo lo que hace falta para saber qué archivo editar a mano.
 */
export function logConfiguration(
  log: vscode.LogOutputChannel,
  runtime: RuntimeInfoProvider,
): void {
  const now = runtime();
  log.info(
    [
      'Extensión en marcha:',
      `  Versión        ${now.version}`,
      `  Host           ${now.host}`,
      `  Commits marcados ${now.marks}`,
      '  Si la versión no es la que instalaste, esta ventana sigue ejecutando el código anterior:',
      '  recárgala con «Developer: Reload Window».',
    ].join('\n'),
  );

  const config = vscode.workspace.getConfiguration('odooTimesheet');
  const keys = [
    'url',
    'db',
    'username',
    'api',
    'daysBack',
    'onlyMyCommits',
    'includeMerges',
    'taskScope',
    'taskLimit',
    'projectId',
    'projectName',
    'allowInsecureTLS',
  ];

  const lines = keys.map((key) => {
    const value = config.get(key);
    const printable = value === '' ? '(vacío)' : JSON.stringify(value);
    return `  odooTimesheet.${key.padEnd(17)} = ${printable}  [${origin(config, key)}]`;
  });

  log.info(
    [
      'Configuración actual (el ámbito indica dónde se está definiendo cada valor):',
      ...lines,
      '  La contraseña / API key NO está aquí: vive en el almacén de secretos de VS Code',
      '  (Administrador de credenciales de Windows). Cámbiala con «Odoo: Cambiar contraseña o API key».',
    ].join('\n'),
  );
}

function origin(config: vscode.WorkspaceConfiguration, key: string): string {
  const inspected = config.inspect(key);
  if (inspected?.workspaceFolderValue !== undefined) {
    return 'carpeta';
  }
  if (inspected?.workspaceValue !== undefined) {
    return 'workspace: .vscode/settings.json';
  }
  if (inspected?.globalValue !== undefined) {
    return 'usuario: settings.json';
  }
  return 'por defecto';
}

function askUrl(): Thenable<string | undefined> {
  return vscode.window
    .showInputBox({
      title: 'URL de Odoo',
      prompt: 'Puedes pegar la URL de cualquier página de Odoo: se recorta sola a la base.',
      placeHolder: 'https://miempresa.odoo.com',
      ignoreFocusOut: true,
      validateInput: (value) => {
        try {
          normalizeBaseUrl(value);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : 'URL no válida';
        }
      },
    })
    .then((value) => (value ? normalizeBaseUrl(value) : undefined));
}

function askUsername(): Thenable<string | undefined> {
  return vscode.window
    .showInputBox({
      title: 'Usuario de Odoo',
      prompt: 'Tu login, normalmente tu correo electrónico',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'Escribe tu usuario.'),
    })
    .then((value) => value?.trim());
}

function askPassword(): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title: 'Contraseña o API key de Odoo',
    prompt:
      'Odoo 19 y superior requieren una API key (Preferencias → Seguridad de la cuenta → Nueva clave de API). La contraseña solo sirve en versiones anteriores y sin verificación en dos pasos.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value ? undefined : 'No puede estar vacía.'),
  });
}

/**
 * Odoo exige el nombre de la base de datos en JSON-RPC. `db.list` suele estar
 * deshabilitado, así que hay tres intentos: preguntarle al servidor, deducirlo
 * del subdominio, y por último preguntárselo al usuario.
 */
async function resolveDatabase(
  url: string,
  insecure: boolean,
  log: vscode.LogOutputChannel,
): Promise<string | undefined> {
  try {
    const databases = await OdooClient.listDatabases(url, insecure);
    if (databases.length === 1) {
      log.info(`Base de datos detectada automáticamente: ${databases[0]}`);
      return databases[0];
    }
    if (databases.length > 1) {
      return await vscode.window.showQuickPick(databases, {
        title: 'Base de datos de Odoo',
        placeHolder: 'Elige la base de datos',
        ignoreFocusOut: true,
      });
    }
  } catch (error) {
    log.info(
      `No se pudo listar las bases de datos (habitual cuando list_db está desactivado): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return vscode.window.showInputBox({
    title: 'Base de datos de Odoo',
    prompt: 'No se pudo detectar automáticamente. En Odoo Online suele ser el subdominio.',
    value: guessDatabaseFromUrl(url) ?? '',
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'Escribe el nombre de la base de datos.'),
  });
}

function guessDatabaseFromUrl(url: string): string | undefined {
  try {
    const hostname = new URL(normalizeBaseUrl(url)).hostname;
    return /^([^.]+)\.odoo\.com$/i.exec(hostname)?.[1];
  } catch {
    return undefined;
  }
}
