import { Json2Transport } from './json2Transport';
import { JsonRpcTransport } from './jsonRpcTransport';
import {
  OdooError,
  type ApiPreference,
  type FieldDescription,
  type Logger,
  type OdooCredentials,
  type OdooTransport,
  type SearchReadOptions,
} from './transport';

export { MISSING_DB, MISSING_USERNAME, OdooError, normalizeBaseUrl } from './transport';
export type {
  ApiPreference,
  FieldDescription,
  Logger,
  OdooCredentials,
  SearchReadOptions,
} from './transport';

/**
 * Fachada única sobre los dos transportes. El resto de la extensión habla solo
 * con esta clase y no sabe por qué API está viajando cada llamada.
 */
export class OdooClient {
  private constructor(private readonly transport: OdooTransport) {}

  /**
   * Elige transporte. En `auto` se sondea primero JSON-2 (Odoo 19+) y se cae a
   * JSON-RPC cuando el endpoint no existe (404) o la credencial no es una API
   * key (401). Un fallo de red nunca provoca el cambio: significaría reintentar
   * contra un servidor que no responde.
   */
  static async connect(
    credentials: OdooCredentials,
    api: ApiPreference,
    log: Logger,
  ): Promise<OdooClient> {
    if (api !== 'jsonrpc') {
      try {
        return new OdooClient(await Json2Transport.connect(credentials, log));
      } catch (error) {
        const odooError = error instanceof OdooError ? error : undefined;
        const recoverable =
          odooError !== undefined &&
          odooError.kind !== 'network' &&
          (odooError.status === 404 || odooError.status === 401 || odooError.kind === 'transport');

        if (api === 'json2' || !recoverable) {
          throw error;
        }
        log(`JSON-2 no disponible (${odooError?.message ?? 'motivo desconocido'}); se usará /jsonrpc`);
      }
    }
    return new OdooClient(await JsonRpcTransport.connect(credentials, log));
  }

  /** Lista las bases de datos por la ruta antigua, que no requiere autenticación. */
  static listDatabases(url: string, insecure: boolean): Promise<string[]> {
    return JsonRpcTransport.listDatabases(url, insecure);
  }

  get api(): 'json2' | 'jsonrpc' {
    return this.transport.kind;
  }

  get url(): string {
    return this.transport.url;
  }

  get db(): string | undefined {
    return this.transport.db;
  }

  get login(): string {
    return this.transport.login;
  }

  get userId(): number {
    return this.transport.userId;
  }

  get serverVersion(): string {
    return this.transport.serverVersion;
  }

  get majorVersion(): number {
    return this.transport.majorVersion;
  }

  searchRead<T>(
    model: string,
    domain: unknown[],
    fields: string[],
    options?: SearchReadOptions,
  ): Promise<T[]> {
    return this.transport.searchRead<T>(model, domain, fields, options);
  }

  fieldsGet(
    model: string,
    allfields: string[],
    attributes: string[] = ['type'],
  ): Promise<Record<string, FieldDescription>> {
    return this.transport.fieldsGet(model, allfields, attributes);
  }

  create(model: string, valsList: Record<string, unknown>[]): Promise<number[]> {
    return this.transport.create(model, valsList);
  }
}
