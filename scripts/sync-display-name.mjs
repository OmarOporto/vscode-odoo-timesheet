/**
 * Pega la versión a los dos nombres visibles:
 *
 *   displayName                  → «Odoo Timesheet 0.1.5», en el gestor de extensiones
 *   viewsContainers[0].title     → «Odoo Timesheet 0.1.5», en la cabecera del panel
 *
 * El segundo es el que importa a diario: una ventana de VS Code abierta desde
 * antes de actualizar sigue ejecutando el código viejo, y sin la versión a la
 * vista eso se confunde con un fallo de la extensión.
 *
 * Lo ejecuta el hook `version` de npm, que corre DESPUÉS de subir la versión en
 * package.json y ANTES de que npm cree el commit del tag, así que el cambio
 * entra en ese mismo commit. Ejecutado a mano no toca el índice de git.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(PROJECT, 'package.json');

const raw = fs.readFileSync(MANIFEST, 'utf8');
const manifest = JSON.parse(raw);
const version = manifest.version;

/** Quita una versión pegada previamente, para no repetir el nombre en dos sitios. */
const stripVersion = (value) =>
  String(value ?? '')
    .replace(/\s+v?\d+\.\d+\.\d+.*$/, '')
    .trim();

const container = manifest.contributes?.viewsContainers?.activitybar?.[0];
const targets = [
  {
    label: 'displayName',
    current: manifest.displayName,
    next: `${stripVersion(manifest.displayName) || manifest.name} ${version}`,
    replace: (text, next) =>
      text.replace(/("displayName"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(next)}`),
  },
  {
    label: 'viewsContainers.title',
    current: container?.title,
    next: `${stripVersion(container?.title) || manifest.name} ${version}`,
    // "title" aparece en cada comando: hay que anclarse al bloque del contenedor
    // y tocar solo la primera ocurrencia que le sigue.
    replace: (text, next) => {
      const anchor = text.indexOf('"activitybar"');
      if (anchor === -1) {
        return text;
      }
      const pattern = /("title"\s*:\s*)"[^"]*"/;
      const match = pattern.exec(text.slice(anchor));
      if (!match) {
        return text;
      }
      const start = anchor + match.index;
      const replaced = match[0].replace(pattern, `$1${JSON.stringify(next)}`);
      return text.slice(0, start) + replaced + text.slice(start + match[0].length);
    },
  },
];

// Reemplazo textual, no JSON.stringify del objeto: reescribirlo reordenaría y
// reformatearía las ~600 líneas de `contributes`.
let updated = raw;
const changed = [];

for (const target of targets) {
  if (target.current === undefined) {
    console.error(`No se encontró ${target.label} en package.json.`);
    process.exit(1);
  }
  if (target.current === target.next) {
    continue;
  }
  const next = target.replace(updated, target.next);
  if (next === updated) {
    console.error(`No se pudo reemplazar ${target.label} en package.json.`);
    process.exit(1);
  }
  updated = next;
  changed.push(`${target.label} → ${target.next}`);
}

if (changed.length === 0) {
  console.log(`Los nombres ya llevan la versión ${version}.`);
  process.exit(0);
}

fs.writeFileSync(MANIFEST, updated);
for (const line of changed) {
  console.log(line);
}

// Solo dentro de `npm version`: ejecutado a mano no debe tocar el índice.
if (process.env.npm_lifecycle_event === 'version') {
  execFileSync('git', ['add', MANIFEST], { cwd: PROJECT, stdio: 'inherit' });
}
