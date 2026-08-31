import {
  httpPost,
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
 * Transporte JSON-2, la API que Odoo 19 introdujo para reemplazar a XML-RPC y
 * JSON-RPC (deprecados y programados para eliminarse en Odoo 22).
 *
 *   POST {base}/json/2/{modelo}/{método}
 *   Authorization: bearer <api-key>
 *   X-Odoo-Database: <db>        (opcional si la instancia tiene una sola base)
 *
 * El cuerpo es un único objeto JSON con parámetros **nombrados**; no hay
 * argumentos posicionales. La respuesta correcta es un 200 con el valor de
 * retorno del método **sin envoltorio**, y los errores llegan con status 4xx/5xx
 * y un cuerpo `{name, message, arguments, context, debug}`.
 */

interface Json2ErrorBody {
  name?: string;
  message?: string;
  debug?: string;
}

/** Lo que devuelve `res.users.context_get()`: el contexto del usuario, con su uid. */
interface UserContext {
  uid?: number;
  lang?: string;
  tz?: string;
}

export class Json2Transport implements OdooTransport {
  readonly kind = 'json2' as const;
  readonly majorVersion: number;

  private constructor(
    readonly url: string,
    readonly db: string | undefined,
    readonly login: string,
    private readonly apiKey: string,
    private readonly insecure: boolean,
    readonly userId: number,
    readonly serverVersion: string,
    private readonly log: Logger,
  ) {
    this.majorVersion = parseMajorVersion(serverVersion);
  }

  /**
   * Sondea el endpoint. Un 404 significa que la instancia es anterior a la 19;
   * un 401, que la credencial no es una API key válida. En ambos casos quien
   * llama puede caer al transporte antiguo, distinguiéndolos por `status`.
   */
  static async connect(credentials: OdooCredentials, log: Logger): Promise<Json2Transport> {
    const base = normalizeBaseUrl(credentials.url);
    const db = credentials.db || undefined;

    const context = await Json2Transport.call<UserContext>(
      base,
      db,
      credentials.password,
      credentials.allowInsecureTLS,
      'res.users',
      'context_get',
      {},
    );

    if (typeof context?.uid !== 'number') {
      throw new OdooError(
        'JSON-2 respondió sin identificar al usuario (context_get no devolvió uid).',
        'transport',
      );
    }

    const serverVersion = await Json2Transport.detectVersion(
      base,
      db,
      credentials.password,
      credentials.allowInsecureTLS,
    );
    const login = await Json2Transport.detectLogin(
      base,
      db,
      credentials.password,
      credentials.allowInsecureTLS,
      context.uid,
      credentials.username,
    );

    log(`JSON-2 conectado a ${base}${db ? ` (db «${db}»)` : ''}, uid ${context.uid}, Odoo ${serverVersion}`);
    return new Json2Transport(
      base,
      db,
      login,
      credentials.password,
      credentials.allowInsecureTLS,
      context.uid,
      serverVersion,
      log,
    );
  }

  /** JSON-2 no expone `common.version`; la versión sale del módulo `base`. */
  private static async detectVersion(
    base: string,
    db: string | undefined,
    apiKey: string,
    insecure: boolean,
  ): Promise<string> {
    try {
      const rows = await Json2Transport.call<{ latest_version?: string }[]>(
        base,
        db,
        apiKey,
        insecure,
        'ir.module.module',
        'search_read',
        { domain: [['name', '=', 'base']], fields: ['latest_version'], limit: 1 },
      );
      return rows?.[0]?.latest_version ?? '19.0+';
    } catch {
      // El endpoint JSON-2 solo existe desde la 19, así que ese es el mínimo.
      return '19.0+';
    }
  }

  private static async detectLogin(
    base: string,
    db: string | undefined,
    apiKey: string,
    insecure: boolean,
    uid: number,
    fallback: string,
  ): Promise<string> {
    try {
      const rows = await Json2Transport.call<{ login?: string; name?: string }[]>(
        base,
        db,
        apiKey,
        insecure,
        'res.users',
        'read',
        { ids: [uid], fields: ['login', 'name'] },
      );
      return rows?.[0]?.login ?? rows?.[0]?.name ?? fallback;
    } catch {
      return fallback;
    }
  }

  private static async call<T>(
    base: string,
    db: string | undefined,
    apiKey: string,
    insecure: boolean,
    model: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const endpoint = new URL(`${base}/json/2/${model}/${method}`);
    const headers: Record<string, string> = { Authorization: `bearer ${apiKey}` };
    if (db) {
      headers['X-Odoo-Database'] = db;
    }

    const { status, body } = await httpPost(endpoint, params, headers, insecure);

    if (status >= 200 && status < 300) {
      // Un cuerpo vacío es válido para métodos que no devuelven nada.
      return (body.trim() ? parseJsonBody(body, endpoint) : undefined) as T;
    }
    throw json2Error(status, body, endpoint);
  }

  private call<T>(model: string, method: string, params: Record<string, unknown>): Promise<T> {
    this.log(`json2 ${model}.${method}`);
    return Json2Transport.call<T>(
      this.url,
      this.db,
      this.apiKey,
      this.insecure,
      model,
      method,
      params,
    );
  }

  async searchRead<T>(
    model: string,
    domain: unknown[],
    fields: string[],
    options: SearchReadOptions = {},
  ): Promise<T[]> {
    const params: Record<string, unknown> = { domain, fields };
    if (options.limit !== undefined) {
      params.limit = options.limit;
    }
    if (options.offset !== undefined) {
      params.offset = options.offset;
    }
    if (options.order !== undefined) {
      params.order = options.order;
    }
    if (options.context !== undefined) {
      params.context = options.context;
    }
    const rows = await this.call<T[]>(model, 'search_read', params);
    return Array.isArray(rows) ? rows : [];
  }

  async fieldsGet(
    model: string,
    allfields: string[],
    attributes: string[],
  ): Promise<Record<string, FieldDescription>> {
    const result = await this.call<Record<string, FieldDescription>>(model, 'fields_get', {
      allfields,
      attributes,
    });
    return result ?? {};
  }

  async create(model: string, valsList: Record<string, unknown>[]): Promise<number[]> {
    // `vals_list` es el nombre del parámetro en la firma de BaseModel.create.
    const result = await this.call<number | number[]>(model, 'create', { vals_list: valsList });
    return Array.isArray(result) ? result : [result];
  }
}

function json2Error(status: number, body: string, endpoint: URL): OdooError {
  let payload: Json2ErrorBody = {};
  try {
    payload = JSON.parse(body) as Json2ErrorBody;
  } catch {
    // Un proxy o una página de error pueden devolver HTML; se usa el status.
  }
  const message = payload.message?.trim();

  if (status === 401) {
    return new OdooError(
      'La API key no es válida. JSON-2 solo acepta API keys, no la contraseña de la cuenta: créala en Odoo (Preferencias → Seguridad de la cuenta → Nueva clave de API).',
      'auth',
      payload.debug,
      401,
    );
  }
  if (status === 403) {
    return new OdooError(
      `Sin permisos: ${message ?? 'acceso denegado'}. Si tu API key tiene un alcance restringido, necesita el alcance «rpc».`,
      'auth',
      payload.debug,
      403,
    );
  }
  if (status === 404) {
    return new OdooError(
      `${endpoint.href} no existe (404). Esta instancia no expone la API JSON-2, que requiere Odoo 19 o superior.`,
      'transport',
      undefined,
      404,
    );
  }
  return new OdooError(
    message ?? `Odoo respondió HTTP ${status}.`,
    'server',
    payload.debug ?? body.slice(0, 300),
    status,
  );
}
