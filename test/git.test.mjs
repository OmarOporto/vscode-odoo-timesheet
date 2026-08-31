/**
 * Verifica la lectura de commits contra un repositorio git real, ejecutando el
 * código de `src/git/gitService.ts` con el módulo `vscode` stubbeado.
 *
 *   node test/git.test.mjs
 */
import esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const TMP = path.join(HERE, '.tmp');
const REPO = path.join(TMP, 'fixture-repo');
const REPO_B = path.join(TMP, 'fixture-repo-b');

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// --- Empaqueta el código real con un stub de `vscode` -----------------------
const vscodeStub = {
  name: 'vscode-stub',
  setup(build) {
    build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `
        class Disposable { constructor(fn) { this.fn = fn; } dispose() {} static from() { return { dispose() {} }; } }
        module.exports = {
          Disposable,
          Uri: { file: (p) => ({ fsPath: p }) },
          workspace: { getConfiguration: () => ({ get: () => undefined }), workspaceFolders: [] },
          extensions: { getExtension: () => undefined },
          window: { activeTextEditor: undefined },
        };`,
      loader: 'js',
    }));
  },
};

for (const [entry, out] of [
  ['src/git/gitService.ts', 'gitService.cjs'],
  ['src/util.ts', 'util.cjs'],
  ['src/lines.ts', 'lines.cjs'],
]) {
  await esbuild.build({
    entryPoints: [path.join(PROJECT, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(TMP, out),
    plugins: [vscodeStub],
    logLevel: 'error',
  });
}

const require = createRequire(import.meta.url);
const git = require(path.join(TMP, 'gitService.cjs'));
const util = require(path.join(TMP, 'util.cjs'));
const lines = require(path.join(TMP, 'lines.cjs'));

// --- Repositorios de prueba -------------------------------------------------
const initRepo = (root) => {
  fs.mkdirSync(root, { recursive: true });
  const at = (args, env = {}) =>
    execFileSync('git', args, { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' });
  at(['init', '-q', '-b', 'main']);
  // Correo con `+`: sin --fixed-strings git lo leería como cuantificador regex.
  at(['config', 'user.email', 'dev+test@example.com']);
  at(['config', 'user.name', 'Dev Test']);
  at(['config', 'commit.gpgsign', 'false']);
  return at;
};

const run = initRepo(REPO);
const runB = initRepo(REPO_B);

const pad = (n) => String(n).padStart(2, '0');
const day = (offset) => {
  const date = new Date();
  date.setDate(date.getDate() - offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const today = day(0);
const yesterday = day(1);

const commitIn = (root, at) => (file, message, authorDate, email = 'dev+test@example.com') => {
  fs.writeFileSync(path.join(root, file), `${message}\n`);
  at(['add', '-A']);
  at(['commit', '-q', '-m', message], {
    GIT_AUTHOR_DATE: authorDate,
    GIT_COMMITTER_DATE: authorDate,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_EMAIL: email,
  });
};

const commit = commitIn(REPO, run);
const commitB = commitIn(REPO_B, runB);

commit('a.txt', 'fix: corrige el redirect de login', `${yesterday}T09:15:00-06:00`);
commit(
  'b.txt',
  'feat: agrega guard de usuario\n\nCuerpo con | pipes, \ttabs\ny varias\nlíneas.',
  `${yesterday}T14:40:00-06:00`,
);
// 23:30 con offset -06:00 ya es el día siguiente en UTC: debe seguir siendo HOY.
commit('c.txt', 'chore: última del día', `${today}T23:30:00-06:00`);
commit('d.txt', 'docs: de otra persona', `${today}T10:00:00-06:00`, 'otro@example.com');

// --- Aserciones -------------------------------------------------------------
const mine = await git.readCommits(REPO, {
  days: 14,
  authorEmail: 'dev+test@example.com',
  includeMerges: false,
});

assert.equal(mine.length, 3, `esperaba 3 commits míos, obtuve ${mine.length}`);
assert.ok(
  !mine.some((c) => c.subject.includes('de otra persona')),
  'el filtro por autor dejó pasar un commit ajeno',
);

const multiline = mine.find((c) => c.subject.startsWith('feat:'));
assert.equal(multiline.subject, 'feat: agrega guard de usuario');
assert.ok(multiline.body.includes('| pipes'), 'el cuerpo perdió el contenido con pipes');
assert.ok(multiline.body.includes('líneas.'), 'el cuerpo multilínea se truncó');
assert.equal(multiline.day, yesterday);
assert.equal(multiline.time, '14:40');

const late = mine.find((c) => c.subject.startsWith('chore:'));
assert.equal(late.day, today, `el commit de las 23:30 se movió de día: ${late.day}`);
assert.equal(late.time, '23:30');

const groups = git.groupByDay(mine);
assert.equal(groups.length, 2);
assert.equal(groups[0].day, today, 'los días deben venir en orden descendente');
assert.equal(groups[0].commits.length, 1);
assert.equal(groups[1].commits.length, 2);

const all = await git.readCommits(REPO, { days: 14, includeMerges: false });
assert.equal(all.length, 4, 'sin filtro de autor deben verse todos');

// Este commit queda como HEAD con fecha de hace 40 días. Es el caso que rompía
// `git log --since`: el walker poda la travesía al primer commit más viejo que
// el corte y devuelve CERO commits, escondiendo todo el historial reciente.
commit('e.txt', 'old: fuera de rango', `${day(40)}T10:00:00-06:00`);
const recent = await git.readCommits(REPO, { days: 14, includeMerges: false });
assert.equal(
  recent.length,
  4,
  'un HEAD con fecha antigua no puede ocultar el historial reciente',
);
assert.ok(
  !recent.some((c) => c.subject.startsWith('old:')),
  'y el commit de hace 40 días sí queda fuera del rango',
);

const emptyRepo = path.join(TMP, 'empty-repo');
fs.mkdirSync(emptyRepo, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: emptyRepo });
assert.deepEqual(
  await git.readCommits(emptyRepo, { days: 14, includeMerges: false }),
  [],
  'un repositorio sin commits debe devolver lista vacía, no lanzar',
);

// --- Varios repositorios agregados ------------------------------------------
commitB('b1.txt', 'chore: setup del segundo repo', `${yesterday}T11:00:00-06:00`);
commitB('b2.txt', 'feat: algo en el otro repo', `${today}T08:30:00-06:00`);

const fromA = await git.readCommits(REPO, { days: 14, authorEmail: 'dev+test@example.com', includeMerges: false });
const fromB = await git.readCommits(REPO_B, { days: 14, authorEmail: 'dev+test@example.com', includeMerges: false });

assert.ok(
  fromA.every((c) => c.repository === REPO),
  'cada commit debe llevar la raíz de su repositorio',
);
assert.ok(fromB.every((c) => c.repository === REPO_B));

const aggregated = git.groupByDay([...fromA, ...fromB]);
assert.equal(aggregated[0].day, today);
assert.deepEqual(
  aggregated[0].commits.map((c) => c.time),
  ['23:30', '08:30'],
  'dentro del día los commits de ambos repos se ordenan por hora descendente',
);
assert.deepEqual(
  aggregated[1].commits.map((c) => c.time),
  ['14:40', '11:00', '09:15'],
  'la mezcla de repositorios respeta el orden cronológico',
);
assert.equal(
  new Set(aggregated[1].commits.map((c) => c.repository)).size,
  2,
  'ese día combina commits de los dos repositorios',
);

// --- pickRepositories (pura) ------------------------------------------------
const discovered = [REPO, REPO_B];
const exists = (candidate) => candidate === REPO || candidate === REPO_B;

assert.deepEqual(
  git.pickRepositories('', discovered, exists).repositories,
  [REPO],
  'automático: solo el primero, que es el del editor activo',
);
assert.deepEqual(
  git.pickRepositories('*', discovered, exists).repositories,
  discovered,
  '"*" agrega todos',
);
assert.deepEqual(
  git.pickRepositories(REPO_B, discovered, exists).repositories,
  [REPO_B],
  'una ruta concreta manda sobre lo descubierto',
);
assert.deepEqual(
  git.pickRepositories('  ', discovered, exists).repositories,
  [REPO],
  'los espacios sueltos cuentan como vacío',
);

const stale = git.pickRepositories('C:\\ya\\no\\existe', discovered, exists);
assert.deepEqual(stale.repositories, [], 'una ruta que ya no es un repo no devuelve nada');
assert.match(
  stale.problem,
  /Elegir repositorio/,
  'y explica cómo arreglarlo en vez de fallar en silencio',
);

// --- planLines: cuántas líneas y con qué fecha ------------------------------
// Cuatro commits míos repartidos en TRES días: hoy, ayer (×2) y hace 40.
const spread = await git.readCommits(REPO, {
  days: 365,
  authorEmail: 'dev+test@example.com',
  includeMerges: false,
});
assert.equal(spread.length, 4);
const FIXED = { kind: 'fixed', day: '2026-09-15' };
const PER_DAY = { kind: 'perCommitDay' };

const groupedFixed = lines.planLines(spread, FIXED, 'grouped');
assert.equal(groupedFixed.length, 1, 'agrupado con fecha fija debe dar UNA sola línea');
assert.equal(groupedFixed[0].day, '2026-09-15');
assert.equal(groupedFixed[0].commits.length, 4, 'y llevarse todos los commits');

const groupedPerDay = lines.planLines(spread, PER_DAY, 'grouped');
assert.deepEqual(
  groupedPerDay.map((draft) => draft.day),
  [today, yesterday, day(40)],
  'agrupado por día: una línea por día, la más reciente primero',
);
assert.deepEqual(
  groupedPerDay.map((draft) => draft.commits.length),
  [1, 2, 1],
);

const perCommitFixed = lines.planLines(spread, FIXED, 'per-commit');
assert.equal(perCommitFixed.length, 4);
assert.ok(
  perCommitFixed.every((draft) => draft.day === '2026-09-15'),
  'por commit con fecha fija: todas comparten fecha',
);
assert.ok(perCommitFixed.every((draft) => draft.commits.length === 1));

const perCommitPerDay = lines.planLines(spread, PER_DAY, 'per-commit');
assert.deepEqual(
  perCommitPerDay.map((draft) => draft.day),
  [today, yesterday, yesterday, day(40)],
  'por commit sin fecha fija: cada uno con su día, en orden cronológico',
);

// El orden de entrada no debe importar: showQuickPick no lo garantiza.
const shuffled = [spread[2], spread[0], spread[3], spread[1]];
assert.deepEqual(
  lines.planLines(shuffled, PER_DAY, 'per-commit').map((draft) => draft.commits[0].hash),
  perCommitPerDay.map((draft) => draft.commits[0].hash),
  'planLines reordena por sí mismo',
);

assert.deepEqual(lines.planLines([], FIXED, 'grouped'), [], 'sin commits, sin líneas');

// --- parseIsoDay ------------------------------------------------------------
assert.equal(util.parseIsoDay('2026-08-31'), '2026-08-31');
assert.equal(util.parseIsoDay('  2026-08-31  '), '2026-08-31', 'tolera espacios');
assert.equal(util.parseIsoDay('2026-02-31'), undefined, 'febrero no tiene 31: new Date lo colaría');
assert.equal(util.parseIsoDay('2026-13-01'), undefined);
assert.equal(util.parseIsoDay('31/08/2026'), undefined);
assert.equal(util.parseIsoDay('2026-8-1'), undefined, 'exige dos dígitos');
assert.equal(util.parseIsoDay(''), undefined);
assert.equal(util.parseIsoDay('2024-02-29'), '2024-02-29', 'año bisiesto sí');

assert.equal(git.repositoryLabel(REPO_B), 'fixture-repo-b');
assert.equal(git.resolveGitRoot(REPO), REPO, 'la raíz se resuelve a sí misma');
assert.equal(
  git.resolveGitRoot(path.join(REPO, 'a.txt')),
  REPO,
  'elegir un archivo o subcarpeta sube hasta la raíz: es lo que necesita «Examinar…»',
);
assert.equal(
  // La raíz del disco: nunca está dentro de un repositorio.
  git.resolveGitRoot(path.parse(TMP).root),
  undefined,
  'una carpeta fuera de todo repositorio no resuelve, y la búsqueda termina',
);

// --- Utilidades puras -------------------------------------------------------
assert.equal(util.parseHours('2.5'), 2.5);
assert.equal(util.parseHours('2,5'), 2.5);
assert.equal(util.parseHours('2:30'), 2.5);
assert.equal(util.parseHours('0:45'), 0.75);
assert.equal(util.parseHours(' 1 '), 1);
assert.equal(util.parseHours('0'), undefined);
assert.equal(util.parseHours('-3'), undefined);
assert.equal(util.parseHours('25'), undefined);
assert.equal(util.parseHours('abc'), undefined);
assert.equal(util.parseHours(''), undefined);
assert.equal(util.parseHours('2:99'), undefined);

assert.equal(util.formatHours(2.5), '2.5 h');
assert.equal(util.formatHours(2), '2 h');
assert.equal(util.formatHours(100), '100 h', 'los ceros de un entero no deben recortarse');
assert.equal(util.formatHours(0.75), '0.75 h');

assert.equal(util.formatDayLabel(today), 'Hoy');
assert.equal(util.formatDayLabel(yesterday), 'Ayer');
assert.equal(util.pluralize(1, 'commit', 'commits'), '1 commit');
assert.equal(util.pluralize(3, 'commit', 'commits'), '3 commits');
assert.equal(util.truncate('abcdefg', 4), 'abc…');
assert.equal(util.truncate('abc', 10), 'abc');

// El cuerpo del commit sí llega a la descripción, colapsado a una línea.
assert.equal(util.joinCommitText('fix: login', ''), 'fix: login');
assert.equal(util.joinCommitText('fix: login', '   '), 'fix: login');
assert.equal(
  util.joinCommitText('fix: login', 'El guard no cubría\nla sesión\t expirada'),
  'fix: login — El guard no cubría la sesión expirada',
);
assert.equal(util.joinCommitText('', 'solo cuerpo'), 'solo cuerpo');
assert.equal(util.joinCommitText('', ''), '');

// Y el commit multilínea del repositorio de prueba, extremo a extremo.
const withBody = util.joinCommitText(multiline.subject, multiline.body);
assert.ok(withBody.startsWith('feat: agrega guard de usuario — '), withBody);
assert.ok(withBody.includes('| pipes'), 'no se pierde el contenido del cuerpo');
assert.ok(!withBody.includes('\n'), 'la descripción va en una sola línea');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`✅ git: ${mine.length} commits propios en ${groups.length} días, y utilidades OK.`);
