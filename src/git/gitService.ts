import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { daysAgo } from '../util';
import type { API, GitExtension } from '../vendor/git';
import type { Commit, DayGroup } from './types';

const run = promisify(execFile);

/**
 * Separadores de campo (US, 0x1f) y de registro (RS, 0x1e). Se usan bytes de
 * control en lugar de `|` o saltos de línea porque un mensaje de commit puede
 * contener cualquier carácter imprimible, incluidos saltos de línea.
 */
const FIELD = '\x1f';
const RECORD = '\x1e';
const FORMAT = '--pretty=format:%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e';

/** Valor de `odooTimesheet.repositoryPath` que significa «todos». */
export const ALL_REPOSITORIES = '*';

export interface ReadCommitsOptions {
  days: number;
  authorEmail?: string;
  includeMerges: boolean;
}

export interface RepositorySelection {
  repositories: string[];
  /** Explicación cuando el ajuste apunta a algo que no sirve. */
  problem?: string;
}

/** Respeta `git.path` de VS Code si el usuario lo configuró. */
function gitExecutable(): string {
  const configured = vscode.workspace.getConfiguration('git').get<string | string[]>('path');
  if (typeof configured === 'string' && configured.trim()) {
    return configured;
  }
  if (Array.isArray(configured)) {
    const first = configured.find((p) => typeof p === 'string' && p.trim());
    if (first) {
      return first;
    }
  }
  return 'git';
}

async function gitApi(): Promise<API | undefined> {
  try {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension) {
      return undefined;
    }
    const exports = extension.isActive ? extension.exports : await extension.activate();
    return exports.getAPI(1);
  } catch {
    return undefined;
  }
}

/** Sube por el árbol de directorios buscando `.git` (directorio o archivo de worktree). */
export function resolveGitRoot(startPath: string): string | undefined {
  let current = startPath;
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function repositoryLabel(root: string): string {
  return path.basename(root) || root;
}

/**
 * Todos los repositorios que se pueden ofrecer, con el del editor activo el
 * primero: es el que el usuario está mirando, y por tanto el que el modo
 * automático debe elegir.
 */
export async function findRepositories(): Promise<string[]> {
  const api = await gitApi();
  const roots = new Set<string>(api?.repositories.map((repo) => repo.rootUri.fsPath) ?? []);

  // La API de git descubre los repos de forma asíncrona: puede estar vacía
  // todavía, así que se completa escaneando las carpetas del workspace.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') {
      continue;
    }
    const root = resolveGitRoot(folder.uri.fsPath);
    if (root) {
      roots.add(root);
    }
  }

  const list = [...roots];
  const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (activePath) {
    const containing = list
      .filter((root) => activePath.toLowerCase().startsWith(root.toLowerCase()))
      .sort((a, b) => b.length - a.length)[0];
    if (containing) {
      return [containing, ...list.filter((root) => root !== containing)];
    }
  }
  return list;
}

/**
 * Aplica el ajuste `odooTimesheet.repositoryPath`. Pura a propósito: la
 * comprobación del sistema de archivos entra como parámetro para poder probarla.
 */
export function pickRepositories(
  setting: string,
  discovered: string[],
  exists: (candidate: string) => boolean = (candidate) => resolveGitRoot(candidate) !== undefined,
): RepositorySelection {
  const value = setting.trim();

  if (value === ALL_REPOSITORIES) {
    return { repositories: discovered };
  }

  if (value) {
    if (!exists(value)) {
      return {
        repositories: [],
        problem: `«${value}» ya no es un repositorio git. Ejecuta «Odoo: Elegir repositorio» para cambiarlo.`,
      };
    }
    return { repositories: [value] };
  }

  return { repositories: discovered.slice(0, 1) };
}

/** Notifica cuando se abre o cierra un repositorio, para refrescar la vista. */
export async function watchRepositories(listener: () => void): Promise<vscode.Disposable> {
  const api = await gitApi();
  if (!api) {
    return new vscode.Disposable(() => undefined);
  }
  return vscode.Disposable.from(
    api.onDidOpenRepository(() => listener()),
    api.onDidCloseRepository(() => listener()),
  );
}

export async function getAuthorEmail(repoRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(gitExecutable(), ['config', '--get', 'user.email'], {
      cwd: repoRoot,
      windowsHide: true,
    });
    return stdout.trim() || undefined;
  } catch {
    // `git config --get` sale con código 1 cuando la clave no existe.
    return undefined;
  }
}

/**
 * Tope de commits que se leen antes de filtrar por fecha. Ver `readCommits`:
 * no se puede usar `--since`, así que el recorte de fecha se hace aquí.
 */
const MAX_COMMITS = 5000;

export async function readCommits(
  repoRoot: string,
  options: ReadCommitsOptions,
): Promise<Commit[]> {
  // Deliberadamente SIN `--since`. El walker de git poda la travesía en cuanto
  // encuentra un commit más viejo que el corte, así que un HEAD con fecha
  // antigua (rebase que conserva fechas, cherry-pick, `--date`, un reloj mal
  // puesto) hace que `git log --since` devuelva CERO commits en silencio.
  // Además `--since` mira la fecha de *commit* mientras que aquí se agrupa por
  // la de *autor*: filtrar en JS por el mismo campo que se muestra evita esa
  // segunda incoherencia.
  const args = ['log', `-n${MAX_COMMITS}`, '--date-order', FORMAT];
  if (!options.includeMerges) {
    args.push('--no-merges');
  }
  if (options.authorEmail) {
    // --fixed-strings evita que un `+` o un `.` del correo se interprete como regex.
    args.push('--fixed-strings', `--author=${options.authorEmail}`);
  }

  try {
    const { stdout } = await run(gitExecutable(), args, {
      cwd: repoRoot,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const cutoff = daysAgo(options.days);
    return parseLog(stdout, repoRoot).filter((commit) => commit.day >= cutoff);
  } catch (error) {
    const message = errorText(error);
    // Repositorio recién inicializado, sin ningún commit todavía.
    if (/does not have any commits yet|unknown revision/i.test(message)) {
      return [];
    }
    if (/ENOENT/.test(message)) {
      throw new Error('No se encontró el ejecutable de git en el PATH.');
    }
    throw new Error(`git log falló en ${repositoryLabel(repoRoot)}: ${message}`);
  }
}

function parseLog(stdout: string, repoRoot: string): Commit[] {
  const commits: Commit[] = [];
  for (const raw of stdout.split(RECORD)) {
    // `--pretty=format:` une registros con un salto de línea que sobra tras el RS.
    const record = raw.replace(/^[\r\n]+/, '');
    if (!record.trim()) {
      continue;
    }
    const fields = record.split(FIELD);
    const hash = fields[0] ?? '';
    if (!hash) {
      continue;
    }
    const isoDate = fields[3] ?? '';
    commits.push({
      hash,
      shortHash: hash.slice(0, 7),
      authorName: fields[1] ?? '',
      authorEmail: fields[2] ?? '',
      isoDate,
      day: isoDate.slice(0, 10),
      time: isoDate.slice(11, 16),
      subject: (fields[4] ?? '').trim(),
      body: (fields[5] ?? '').trim(),
      repository: repoRoot,
    });
  }
  return commits;
}

export function groupByDay(commits: Commit[]): DayGroup[] {
  const byDay = new Map<string, Commit[]>();
  for (const commit of commits) {
    const existing = byDay.get(commit.day);
    if (existing) {
      existing.push(commit);
    } else {
      byDay.set(commit.day, [commit]);
    }
  }
  return [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, list]) => ({
      day,
      // Al agregar varios repositorios el orden se mezcla: se reordena por
      // instante real, no por texto, porque los offsets pueden diferir.
      commits: list.sort((a, b) => Date.parse(b.isoDate) - Date.parse(a.isoDate)),
    }));
}

function errorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const withStderr = error as { stderr?: string; message?: string };
    if (withStderr.stderr && withStderr.stderr.trim()) {
      return withStderr.stderr.trim();
    }
    if (withStderr.message) {
      return withStderr.message;
    }
  }
  return String(error);
}
