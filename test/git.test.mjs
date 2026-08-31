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

// --- Repositorio de prueba --------------------------------------------------
fs.mkdirSync(REPO, { recursive: true });
const run = (args, env = {}) =>
  execFileSync('git', args, { cwd: REPO, env: { ...process.env, ...env }, encoding: 'utf8' });

run(['init', '-q', '-b', 'main']);
// Correo con `+`: sin --fixed-strings git lo interpretaría como cuantificador regex.
run(['config', 'user.email', 'dev+test@example.com']);
run(['config', 'user.name', 'Dev Test']);
run(['config', 'commit.gpgsign', 'false']);

const pad = (n) => String(n).padStart(2, '0');
const day = (offset) => {
  const date = new Date();
  date.setDate(date.getDate() - offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const today = day(0);
const yesterday = day(1);

const commit = (file, message, authorDate, email = 'dev+test@example.com') => {
  fs.writeFileSync(path.join(REPO, file), `${message}\n`);
  run(['add', '-A']);
  run(['commit', '-q', '-m', message], {
    GIT_AUTHOR_DATE: authorDate,
    GIT_COMMITTER_DATE: authorDate,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_EMAIL: email,
  });
};

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

commit('e.txt', 'old: fuera de rango', `${day(40)}T10:00:00-06:00`);
const recent = await git.readCommits(REPO, { days: 14, includeMerges: false });
assert.ok(
  !recent.some((c) => c.subject.startsWith('old:')),
  '--since no filtró un commit de hace 40 días',
);

const emptyRepo = path.join(TMP, 'empty-repo');
fs.mkdirSync(emptyRepo, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: emptyRepo });
assert.deepEqual(
  await git.readCommits(emptyRepo, { days: 14, includeMerges: false }),
  [],
  'un repositorio sin commits debe devolver lista vacía, no lanzar',
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

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`✅ git: ${mine.length} commits propios en ${groups.length} días, y utilidades OK.`);
