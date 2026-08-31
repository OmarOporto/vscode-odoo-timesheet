import * as vscode from 'vscode';
import { normalizeBaseUrl, OdooClient, OdooError } from '../odoo/client';
import { searchTasks } from '../odoo/tasks';
import { readSettings, type OdooSession } from '../state';

const GLOBAL = vscode.ConfigurationTarget.Global;

export async function connectCommand(
  session: OdooSession,
  log: vscode.LogOutputChannel,
): Promise<void> {
  const config = vscode.workspace.getConfiguration('odooTimesheet');
  const settings = readSettings();
  const insecure = settings.allowInsecureTLS;

  const url = settings.url || (await askUrl());
  if (!url) {
    return;
  }
  if (url !== settings.url) {
    await config.update('url', url, GLOBAL);
  }

  const username = settings.username || (await askUsername());
  if (!username) {
    return;
  }
  if (username !== settings.username) {
    await config.update('username', username, GLOBAL);
  }

  const db = settings.db || (await resolveDatabase(url, insecure, log));
  if (!db) {
    return;
  }
  if (db !== settings.db) {
    await config.update('db', db, GLOBAL);
  }

  let stored = await session.readPassword();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const password = stored ?? (await askPassword());
    if (!password) {
      return;
    }

    try {
      const connection = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Conectando a ${url}…` },
        () => session.connect({ url, db, username, password, allowInsecureTLS: insecure }),
      );
      await session.storePassword(password);
      void vscode.window.showInformationMessage(
        `Conectado a Odoo ${connection.schema.serverVersion} como ${username}.`,
      );
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Fallo al conectar: ${message}`);

      const isAuthProblem = error instanceof OdooError && error.kind === 'auth';
      if (isAuthProblem && attempt < 2) {
        await session.clearPassword();
        stored = undefined;
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

export async function testConnectionCommand(
  session: OdooSession,
  log: vscode.LogOutputChannel,
): Promise<void> {
  if (!session.isConnected) {
    await connectCommand(session, log);
    return;
  }

  const { client, schema } = session.requireConnection();
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Probando la conexión con Odoo…' },
      async () => {
        const serverVersion = await client.version();
        const tasks = await searchTasks(client, schema, { scope: 'assigned', limit: 1 });
        const employeeId = await session.getEmployeeId();

        log.info(
          [
            'Prueba de conexión correcta:',
            `  URL           ${client.url}`,
            `  Base de datos ${client.db}`,
            `  Usuario       ${client.login} (uid ${client.userId})`,
            `  Versión       ${serverVersion}`,
            `  Asignado      ${schema.assigneeField}`,
            `  Empleado      id ${employeeId}`,
            `  Tareas        ${tasks.length > 0 ? 'lectura correcta' : 'sin tareas asignadas'}`,
          ].join('\n'),
        );
        void vscode.window
          .showInformationMessage(
            `Odoo ${serverVersion} · uid ${client.userId} · empleado ${employeeId}.`,
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

function askUrl(): Thenable<string | undefined> {
  return vscode.window
    .showInputBox({
      title: 'URL de Odoo',
      prompt: 'Por ejemplo https://miempresa.odoo.com',
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
      'Si tu cuenta tiene verificación en dos pasos, la contraseña no sirve para la API: usa una API key (Preferencias → Seguridad de la cuenta → Nueva clave de API).',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value ? undefined : 'No puede estar vacía.'),
  });
}

/**
 * Odoo exige el nombre de la base de datos. `db.list` suele estar deshabilitado
 * en Odoo Online, así que hay tres intentos: preguntarle al servidor, deducirlo
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
      `No se pudo listar las bases de datos (normal en Odoo Online): ${
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
