import {
  httpPost,
  MISSING_DB,
  MISSING_USERNAME,
  normalizeBaseUrl,
  OdooError,
  parseJsonBody,
  parseMajorVersion,
  type FieldDescription,
  type Logger,
  type OdooCredentials,
  type OdooTransport,
  type SearchReadOptions,
} from './transport';

/**
 * Transporte JSON-RPC clásico: `POST {base}/jsonrpc`, la ruta que Odoo define en
 * `addons/base/controllers/rpc.py` y que despacha a los mismos servicios que
 * XML-RPC (`common.authenticate`, `object.execute_kw`).
 *
 * Sirve de Odoo 15 a 19. La documentación de la 19 lo marca como deprecado y
 * programado para eliminarse en Odoo 22 (otoño de 2028); hasta entonces es el
 * único camino para las versiones anteriores a la 19.
 */

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

export class JsonRpcTransport implements OdooTransport {
  readonly kind = 'jsonrpc' as const;
  readonly majorVersion: number;

  private sequence = 0;

  private constructor(
    readonly url: string,
    readonly db: string,
    readonly login: string,
    private readonly password: string,
    private readonly insecure: boolean,
    readonly userId: number,
    readonly serverVersion: string,
    private readonly log: Logger,
  ) {
    this.majorVersion = parseMajorVersion(serverVersion);
  }

  static async connect(credentials: OdooCredentials, log: Logger): Promise<JsonRpcTransport> {
    const base = normalizeBaseUrl(credentials.url);
    if (!credentials.db) {
      throw new OdooError(
        'Para conectar por JSON-RPC hace falta el nombre de la base de datos.',
        'auth',
        MISSING_DB,
      );
    }
    if (!credentials.username) {
      throw new OdooError(
        'Para conectar por JSON-RPC hace falta el usuario.',
        'auth',
        MISSING_USERNAME,
      );
    }

    const serverVersion = await JsonRpcTransport.rpcOnce(
      base,
      credentials.allowInsecureTLS,
      'common',
      'version',
      [],
      0,
    ).then((result) => (result as { server_version?: string } | undefined)?.server_version ?? 'desconocida');

    // Ojo: `authenticate` lleva un cuarto argumento (el env del cliente), a
    // diferencia de `login`.
    const uid = await JsonRpcTransport.rpcOnce(
      base,
      credentials.allowInsecureTLS,
      'common',
      'authenticate',
      [credentials.db, credentials.username, credentials.password, {}],
      1,
    );

    if (typeof uid !== 'number' || uid <= 0) {
      throw new OdooError(
        'Usuario o contraseña incorrectos. Si tu cuenta tiene verificación en dos pasos activada, la contraseña no sirve para la API: crea una API key en Odoo (Preferencias → Seguridad de la cuenta → Nueva clave de API) y úsala aquí.',
        'auth',
      );
    }

    log(`JSON-RPC conectado a ${base} (db «${credentials.db}»), uid ${uid}, Odoo ${serverVersion}`);
    return new JsonRpcTransport(
      base,
      credentials.db,
      credentials.username,
      credentials.password,
      credentials.allowInsecureTLS,
      uid,
      serverVersion,
      log,
    );
  }

  /** Lista las bases de datos. Suele estar deshabilitado en Odoo Online. */
  static async listDatabases(url: string, insecure: boolean): Promise<string[]> {
    const result = await JsonRpcTransport.rpcOnce(
      normalizeBaseUrl(url),
      insecure,
      'db',
      'list',
      [],
      1,
    );
    return Array.isArray(result) ? result.filter((db): db is string => typeof db === 'string') : [];
  }

  private static async rpcOnce(
    base: string,
    insecure: boolean,
    service: string,
    method: string,
    args: unknown[],
    id: number,
  ): Promise<unknown> {
    const endpoint = new URL(`${base}/jsonrpc`);
    const { status, body } = await httpPost(
      endpoint,
      { jsonrpc: '2.0', method: 'call', id, params: { service, method, args } },
      {},
      insecure,
    );

    if (status === 404) {
      throw new OdooError(
        `${endpoint.href} devolvió 404. Revisa la URL base, o si un proxy está bloqueando la ruta /jsonrpc.`,
        'transport',
        undefined,
        404,
      );
    }
    if (status < 200 || status >= 300) {
      throw new OdooError(
        `Odoo respondió HTTP ${status}.`,
        'transport',
        body.slice(0, 500),
        status,
      );
    }

    const parsed = parseJsonBody(body, endpoint) as JsonRpcResponse;
    if (parsed.error) {
      throw toOdooError(parsed.error);
    }
    return parsed.result;
  }

  private async execute<T>(
    model: string,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown> = {},
  ): Promise<T> {
    this.log(`jsonrpc ${model}.${method}`);
    // Nunca se registran los argumentos: llevan la contraseña / API key.
    const result = await JsonRpcTransport.rpcOnce(
      this.url,
      this.insecure,
      'object',
      'execute_kw',
      [this.db, this.userId, this.password, model, method, args, kwargs],
      ++this.sequence + 1,
    );
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

  async fieldsGet(
    model: string,
    allfields: string[],
    attributes: string[],
  ): Promise<Record<string, FieldDescription>> {
    const result = await this.execute<Record<string, FieldDescription>>(model, 'fields_get', [
      allfields,
      attributes,
    ]);
    return result ?? {};
  }

  /**
   * Con una lista de diccionarios Odoo devuelve `recs.ids`; con un diccionario
   * suelto devuelve `recs.id`. Se normaliza siempre a lista.
   */
  async create(model: string, valsList: Record<string, unknown>[]): Promise<number[]> {
    const result = await this.execute<number | number[]>(model, 'create', [valsList]);
    return Array.isArray(result) ? result : [result];
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
