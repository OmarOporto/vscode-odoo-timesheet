import { groupByDay } from './git/gitService';
import type { Commit } from './git/types';

/**
 * Decide cuántas líneas de horas se crean y con qué fecha.
 *
 * Está fuera del flujo interactivo a propósito: es la parte que de verdad
 * cambia de comportamiento según lo que elija el usuario, y así se puede probar
 * sin VS Code de por medio.
 */

export type LineMode = 'grouped' | 'per-commit';

export type LineDate =
  /** Cada commit conserva su propio día. */
  | { kind: 'perCommitDay' }
  /** Todas las líneas comparten la misma fecha. */
  | { kind: 'fixed'; day: string };

export interface LineDraft {
  /** `YYYY-MM-DD` */
  day: string;
  commits: Commit[];
}

export function planLines(commits: Commit[], date: LineDate, mode: LineMode): LineDraft[] {
  // Orden estable, del más reciente al más antiguo, igual que el árbol.
  // `showQuickPick` no garantiza en qué orden devuelve la selección múltiple.
  const ordered = [...commits].sort((a, b) => Date.parse(b.isoDate) - Date.parse(a.isoDate));

  if (ordered.length === 0) {
    return [];
  }

  if (mode === 'per-commit') {
    return ordered.map((commit) => ({
      day: date.kind === 'fixed' ? date.day : commit.day,
      commits: [commit],
    }));
  }

  // Agrupado con fecha fija: dos líneas con la misma fecha y la misma tarea no
  // aportan nada y pedirían las horas dos veces, así que se funden en una.
  if (date.kind === 'fixed') {
    return [{ day: date.day, commits: ordered }];
  }

  return groupByDay(ordered).map((group) => ({ day: group.day, commits: group.commits }));
}
