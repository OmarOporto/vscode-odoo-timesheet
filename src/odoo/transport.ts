import * as http from 'node:http';
import * as https from 'node:https';

/**
 * Piezas compartidas por los dos transportes hacia Odoo.
 *
 * La interfaz común está expresada con **parámetros nombrados**, que es el
 * estilo de la API JSON-2 de Odoo 19. El transporte antiguo (JSON-RPC) los
 * traduce a los argumentos posicionales de `execute_kw`, que es la dirección
 * fácil de la traducción.
 */

export type OdooErrorKind = 'network' | 'transport' | 'auth' | 'server';

export class OdooError extends Error {
  constructor(
    message: string,
    readonly kind: OdooErrorKind,
    readonly detail?: string,
    /** Código HTTP, cuando el fallo vino de una respuesta del servidor. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OdooError';
  }
}

export interface OdooCredentials {
  url: string;
  /** Opcional con JSON-2: la API key ya identifica la base y al usuario. */
  db: string;
  /** Opcional con JSON-2: solo lo necesita el login de JSON-RPC. */
  username: string;
  /** Contraseña (solo JSON-RPC) o API key (ambos). */
  password: string;
  allowInsecureTLS: boolean;
}

export type ApiPreference = 'auto' | 'json2' | 'jsonrpc';

export type Logger = (message: string) => void;

export interface SearchReadOptions {
  limit?: number;
  offset?: number;
  order?: string;
  context?: Record<string, unknown>;
}

export interface FieldDescription {
  type?: string;
  string?: string;
}

export interface OdooTransport {
  readonly kind: 'json2' | 'jsonrpc';
  readonly url: string;
  readonly db: string | undefined;
  readonly login: string;
  readonly userId: number;
  readonly serverVersion: string;
  readonly majorVersion: number;

  searchRead<T>(
    model: string,
    domain: unknown[],
    fields: string[],
    options?: SearchReadOptions,
  ): Promise<T[]>;

  fieldsGet(
    model: string,
    allfields: string[],
    attributes: string[],
  ): Promise<Record<string, FieldDescription>>;

  create(model: string, valsList: Record<string, unknown>[]): Promise<number[]>;
}

export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Marcadores que viajan en `OdooError.detail` cuando falta un dato que el
 * comando de conexión puede pedir al usuario, en vez de tener que reconocer el
 * caso comparando textos de error.
 */
export const MISSING_DB = 'odoo.missing.db';
export const MISSING_USERNAME = 'odoo.missing.username';

/**
 * Acepta `miempresa.odoo.com`, `https://host/`, y también una URL copiada del
 * cliente web (`https://host/odoo/timesheets/project.task/2488`), de la que hay
 * que recortar **desde** el segmento `/odoo` o `/web` en adelante — no solo al
 * final, que es donde estaba el fallo.
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

  const pathname = parsed.pathname
    .replace(/\/(odoo|web|json)(\/.*)?$/i, '')
    .replace(/\/+$/, '');
  return `${parsed.origin}${pathname}`;
}

/** El servidor sirve `major.minor…`; `saas~17.2` también empieza por el mayor. */
export function parseMajorVersion(serverVersion: string): number {
  const match = /(\d+)/.exec(serverVersion);
  return match ? Number(match[1]) : 0;
}

export interface HttpResponse {
  status: number;
  body: string;
}

/**
 * POST crudo. Se usa `node:https` en vez de `fetch` porque es la única forma de
 * desactivar la verificación TLS *por petición* sin tocar
 * `NODE_TLS_REJECT_UNAUTHORIZED`, que afectaría a todo el proceso de VS Code.
 */
export function httpPost(
  endpoint: URL,
  payload: unknown,
  headers: http.OutgoingHttpHeaders,
  insecure: boolean,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = endpoint.protocol === 'https:';
    const body = Buffer.from(JSON.stringify(payload), 'utf8');

    const options: https.RequestOptions = {
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port || (isHttps ? 443 : 80),
      path: `${endpoint.pathname}${endpoint.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.byteLength,
        Accept: 'application/json',
        'User-Agent': 'vscode-odoo-timesheet',
        ...headers,
      },
    };
    if (isHttps) {
      options.rejectUnauthorized = !insecure;
    }

    const handleResponse = (response: http.IncomingMessage): void => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    };

    const request = isHttps
      ? https.request(options, handleResponse)
      : http.request(options, handleResponse);

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(
        new OdooError(`Odoo no respondió en ${REQUEST_TIMEOUT_MS / 1000} segundos.`, 'network'),
      );
    });
    request.on('error', (error: Error) => reject(networkError(error, endpoint)));
    request.end(body);
  });
}

export function networkError(error: Error, endpoint: URL): OdooError {
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

export function parseJsonBody(text: string, endpoint: URL): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new OdooError(
      `La respuesta de ${endpoint.href} no es JSON. ¿La URL apunta realmente a una instancia de Odoo?`,
      'transport',
      text.slice(0, 300),
    );
  }
}
