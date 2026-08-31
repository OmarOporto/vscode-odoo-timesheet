import * as http from 'node:http';
import * as https from 'node:https';

/**
 * Cliente JSON-RPC para Odoo.
 *
 * Habla contra `POST {base}/jsonrpc`, que en Odoo está definido en
 * `odoo/addons/base/controllers/rpc.py` con `auth="none"` y despacha a los
 * mismos servicios que XML-RPC (`common.authenticate`, `object.execute_kw`).
 * Eso permite cero dependencias: nada de XML ni de clientes HTTP externos.
 *
 * Se usa `node:https` en vez de `fetch` por una razón concreta: es la única
 * forma de desactivar la verificación TLS *por petición* (instancias
 * on-premise con certificado autofirmado) sin tocar
 * `NODE_TLS_REJECT_UNAUTHORIZED`, que afectaría a todo el proceso de VS Code.
 */

export type OdooErrorKind = 'network' | 'transport' | 'auth' | 'server';

export class OdooError extends Error {
  constructor(
    message: string,
    readonly kind: OdooErrorKind,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'OdooError';
  }
}

export interface OdooCredentials {
  url: string;
  db: string;
  username: string;
  password: string;
  allowInsecureTLS: boolean;
}

export type Logger = (message: string) => void;

export interface SearchReadOptions {
  limit?: number;
  offset?: number;
  order?: string;
  context?: Record<string, unknown>;
}

interface JsonRpcError {
  code?: number;
  message?: string;
  data?: {
    name?: string;
    message?: string;
    debug?: string;
  };
}

interface JsonRpcResponse {
  result?: unknown;
  error?: JsonRpcError;
}

const TIMEOUT_MS = 30_000;

/**
 * Acepta `miempresa.odoo.com`, `https://miempresa.odoo.com/`, o incluso una URL
 * copiada del cliente web (`.../web#id=...`), y devuelve siempre la base limpia.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new OdooError('La URL de Odoo está vacía.', 'transport');
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new OdooError(`La URL «${raw}» no es válida.`, 'transport');
  }
  const pathname = parsed.pathname.replace(/\/+$/, '').replace(/\/(web|odoo)$/i, '');
  return `${parsed.origin}${pathname}`;
}

function post(
  baseUrl: string,
  routePath: string,
  payload: unknown,
  insecure: boolean,
): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(baseUrl + routePath);
    const isHttps = endpoint.protocol === 'https:';
    const body = Buffer.from(JSON.stringify(payload), 'utf8');

    const options: https.RequestOptions = {
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port || (isHttps ? 443 : 80),
      path: `${endpoint.pathname}${endpoint.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.byteLength,
        Accept: 'application/json',
        'User-Agent': 'vscode-odoo-timesheet',
      },
    };
    if (isHttps) {
      options.rejectUnauthorized = !insecure;
    }

    const handleResponse = (response: http.IncomingMessage): void => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = response.statusCode ?? 0;

        if (status === 404) {
          reject(
            new OdooError(
              `${endpoint.href} devolvió 404. Revisa la URL base, o si un proxy está bloqueando la ruta /jsonrpc.`,
              'transport',
            ),
          );
          return;
        }
        if (status < 200 || status >= 300) {
          reject(new OdooError(`Odoo respondió HTTP ${status}.`, 'transport', text.slice(0, 500)));
          return;
        }
        try {
          resolve(JSON.parse(text) as JsonRpcResponse);
        } catch {
          reject(
            new OdooError(
              'La respuesta no es JSON. ¿La URL apunta realmente a una instancia de Odoo?',
              'transport',
              text.slice(0, 300),
            ),
          );
        }
      });
    };

    const request = isHttps ? https.request(options, handleResponse) : http.request(options, handleResponse);
    request.setTimeout(TIMEOUT_MS, () => {
      request.destroy(new OdooError(`Odoo no respondió en ${TIMEOUT_MS / 1000} segundos.`, 'network'));
    });
    request.on('error', (error: Error) => reject(networkError(error, endpoint)));
    request.end(body);
  });
}

function networkError(error: Error, endpoint: URL): OdooError {
  if (error instanceof OdooError) {
    return error;
  }
  const code = (error as NodeJS.ErrnoException).code;
  switch (code) {
    case 'ENOTFOUND':
      return new OdooError(`No se pudo resolver el host «${endpoint.hostname}».`, 'network');
    case 'ECONNREFUSED':
      return new OdooError(`Conexión rechazada por ${endpoint.host}.`, 'network');
    case 'ETIMEDOUT':
      return new OdooError(`Tiempo de espera agotado conectando a ${endpoint.host}.`, 'network');
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'CERT_HAS_EXPIRED':
      return new OdooError(
        'No se pudo verificar el certificado TLS. Si es una instancia on-premise de confianza, activa la opción odooTimesheet.allowInsecureTLS.',
        'network',
      );
    default:
      return new OdooError(`Fallo de red: ${error.message}`, 'network');
  }
}

/**
 * Las rutas `type='json'` de Odoo responden HTTP 200 incluso cuando fallan: el
 * error viaja dentro del cuerpo. Aquí se convierte en algo legible en vez de un
 * traceback de Python.
 */
function toOdooError(error: JsonRpcError): OdooError {
  const data = error.data ?? {};
  const name = data.name ?? '';
  const message = (data.message ?? error.message ?? 'Error desconocido de Odoo').trim();

  if (/AccessDenied/i.test(name)) {
    return new OdooError(
      'Odoo rechazó las credenciales. Si tu cuenta usa verificación en dos pasos, necesitas una API key en lugar de la contraseña.',
      'auth',
      data.debug,
    );
  }
  if (/AccessError/i.test(name)) {
    return new OdooError(`Sin permisos en Odoo: ${message}`, 'server', data.debug);
  }
  return new OdooError(message, 'server', data.debug);
}

export class OdooClient {
  private uid: number | undefined;
  private sequence = 0;
  private readonly base: string;

  constructor(
    private readonly credentials: OdooCredentials,
    private readonly log: Logger,
  ) {
    this.base = normalizeBaseUrl(credentials.url);
  }

  get url(): string {
    return this.base;
  }

  get db(): string {
    return this.credentials.db;
  }

  get login(): string {
    return this.credentials.username;
  }

  get userId(): number | undefined {
    return this.uid;
  }

  /** Lista las bases de datos disponibles. Suele estar deshabilitado en Odoo Online. */
  static async listDatabases(url: string, insecure: boolean): Promise<string[]> {
    const response = await post(
      normalizeBaseUrl(url),
      '/jsonrpc',
      { jsonrpc: '2.0', method: 'call', id: 1, params: { service: 'db', method: 'list', args: [] } },
      insecure,
    );
    if (response.error) {
      throw toOdooError(response.error);
    }
    return Array.isArray(response.result)
      ? response.result.filter((db): db is string => typeof db === 'string')
      : [];
  }

  private async rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
    const payload = {
      jsonrpc: '2.0',
      method: 'call',
      id: ++this.sequence,
      params: { service, method, args },
    };
    const startedAt = Date.now();
    // Nunca se registran los args: contienen la contraseña / API key.
    const response = await post(this.base, '/jsonrpc', payload, this.credentials.allowInsecureTLS);
    this.log(`${service}.${method} — ${Date.now() - startedAt} ms`);

    if (response.error) {
      throw toOdooError(response.error);
    }
    return response.result;
  }

  async version(): Promise<string> {
    const result = (await this.rpc('common', 'version', [])) as { server_version?: string } | undefined;
    return result?.server_version ?? 'desconocida';
  }

  async authenticate(): Promise<number> {
    // Ojo: `authenticate` lleva un cuarto argumento (el env del cliente), a diferencia de `login`.
    const result = await this.rpc('common', 'authenticate', [
      this.credentials.db,
      this.credentials.username,
      this.credentials.password,
      {},
    ]);

    if (typeof result !== 'number' || result <= 0) {
      throw new OdooError(
        'Usuario o contraseña incorrectos. Si tu cuenta tiene verificación en dos pasos activada, la contraseña no sirve para la API: crea una API key en Odoo (Preferencias → Seguridad de la cuenta → Nueva clave de API) y úsala aquí.',
        'auth',
      );
    }
    this.uid = result;
    return result;
  }

  async execute<T>(
    model: string,
    method: string,
    args: unknown[] = [],
    kwargs: Record<string, unknown> = {},
  ): Promise<T> {
    const uid = this.uid ?? (await this.authenticate());
    this.log(`${model}.${method}`);
    const result = await this.rpc('object', 'execute_kw', [
      this.credentials.db,
      uid,
      this.credentials.password,
      model,
      method,
      args,
      kwargs,
    ]);
    return result as T;
  }

  async searchRead<T>(
    model: string,
    domain: unknown[],
    fields: string[],
    options: SearchReadOptions = {},
  ): Promise<T[]> {
    const kwargs: Record<string, unknown> = { fields };
    if (options.limit !== undefined) {
      kwargs.limit = options.limit;
    }
    if (options.offset !== undefined) {
      kwargs.offset = options.offset;
    }
    if (options.order !== undefined) {
      kwargs.order = options.order;
    }
    if (options.context !== undefined) {
      kwargs.context = options.context;
    }
    const rows = await this.execute<T[]>(model, 'search_read', [domain], kwargs);
    return Array.isArray(rows) ? rows : [];
  }

  /**
   * `create` con una lista de diccionarios crea todos los registros en una sola
   * llamada y devuelve la lista de ids (Odoo devuelve `recs.ids` cuando el
   * argumento es una lista, y `recs.id` cuando es un diccionario suelto).
   */
  async create(model: string, values: Record<string, unknown>[]): Promise<number[]> {
    const result = await this.execute<number | number[]>(model, 'create', [values]);
    return Array.isArray(result) ? result : [result];
  }
}
