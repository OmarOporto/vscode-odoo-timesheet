/**
 * Registro local de los commits que ya se convirtieron en horas.
 *
 * Vive en la extensión y no en Odoo porque `account.analytic.line` no tiene
 * ningún campo de texto libre aparte de la descripción: guardar ahí el hash
 * significaría ensuciar lo que el equipo ve en la rejilla de horas.
 *
 * No importa `vscode` a propósito. El almacén entra como parámetro con la misma
 * forma que `Memento`, así que el módulo se puede probar en Node puro.
 */

export interface RegisteredCommit {
  taskId: number;
  taskName: string;
  hours: number;
  /** Fecha de la línea de horas, `YYYY-MM-DD`. */
  day: string;
  /** Cuándo se registró, ISO. Es lo que decide qué se poda. */
  at: string;
}

export type RegistryMap = Record<string, RegisteredCommit>;

export interface RegistryStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

export const REGISTRY_KEY = 'odooTimesheet.registeredCommits';

/**
 * Tope de entradas. Con 14 días de historial visible nunca se acerca, pero el
 * mapa se sincroniza entre máquinas y no debe crecer sin freno con los años.
 */
export const MAX_ENTRIES = 5000;

export function pruneRegistry(map: RegistryMap, max: number = MAX_ENTRIES): RegistryMap {
  const hashes = Object.keys(map);
  if (hashes.length <= max) {
    return map;
  }

  const kept = hashes
    .sort((a, b) => {
      // Más recientes primero; el hash desempata para que la poda sea estable
      // cuando dos entradas comparten instante.
      const byDate = String(map[b].at).localeCompare(String(map[a].at));
      return byDate !== 0 ? byDate : a.localeCompare(b);
    })
    .slice(0, max);

  const pruned: RegistryMap = {};
  for (const hash of kept) {
    pruned[hash] = map[hash];
  }
  return pruned;
}

export class CommitRegistry {
  private entries: RegistryMap;

  constructor(private readonly store: RegistryStore) {
    // Copia propia: lo que devuelve el almacén no debe mutarse en sitio.
    this.entries = { ...store.get<RegistryMap>(REGISTRY_KEY, {}) };
  }

  get size(): number {
    return Object.keys(this.entries).length;
  }

  isRegistered(hash: string): boolean {
    return this.entries[hash] !== undefined;
  }

  get(hash: string): RegisteredCommit | undefined {
    return this.entries[hash];
  }

  async record(entries: Array<{ hash: string; info: RegisteredCommit }>): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const next: RegistryMap = { ...this.entries };
    for (const { hash, info } of entries) {
      next[hash] = info;
    }
    this.entries = pruneRegistry(next);
    await this.store.update(REGISTRY_KEY, this.entries);
  }

  async forget(hashes: string[]): Promise<void> {
    const next: RegistryMap = { ...this.entries };
    let changed = false;
    for (const hash of hashes) {
      if (next[hash] !== undefined) {
        delete next[hash];
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
    this.entries = next;
    await this.store.update(REGISTRY_KEY, this.entries);
  }

  async clear(): Promise<void> {
    this.entries = {};
    await this.store.update(REGISTRY_KEY, this.entries);
  }
}
