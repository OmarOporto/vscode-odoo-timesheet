export interface Commit {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  /** Fecha ISO completa con el offset del autor, tal cual la reporta git (%aI). */
  isoDate: string;
  /** Día local del autor, `YYYY-MM-DD`. Se recorta de `isoDate`, nunca se recalcula con Date. */
  day: string;
  /** Hora local del autor, `HH:mm`. */
  time: string;
  subject: string;
  body: string;
  /** Raíz del repositorio del que salió, para poder agregar varios. */
  repository: string;
}

export interface DayGroup {
  /** `YYYY-MM-DD` */
  day: string;
  commits: Commit[];
}
