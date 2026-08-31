/**
 * Mantiene `displayName` con la versión pegada: «Odoo Timesheet 0.1.2».
 *
 * Lo ejecuta el hook `version` de npm, que corre DESPUÉS de subir la versión en
 * package.json y ANTES de que npm cree el commit del tag. Por eso el cambio
 * entra en ese mismo commit y no se queda descolgado.
 *
 * Ejecutado a mano no toca el índice de git, solo el archivo.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(PROJECT, 'package.json');

const raw = fs.readFileSync(MANIFEST, 'utf8');
const manifest = JSON.parse(raw);

// La base sale del propio displayName quitándole una versión anterior, para no
// dejar el nombre escrito en dos sitios.
const base =
  String(manifest.displayName ?? '')
    .replace(/\s+v?\d+\.\d+\.\d+.*$/, '')
    .trim() || manifest.name;
const next = `${base} ${manifest.version}`;

if (manifest.displayName === next) {
  console.log(`displayName ya está al día: ${next}`);
  process.exit(0);
}

// Reemplazo textual, no JSON.stringify: reescribir el objeto reordenaría y
// reformatearía todo el manifiesto.
const updated = raw.replace(/("displayName"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(next)}`);
if (updated === raw) {
  console.error('No se encontró el campo displayName en package.json.');
  process.exit(1);
}

fs.writeFileSync(MANIFEST, updated);
console.log(`displayName → ${next}`);

// Solo dentro de `npm version`: ejecutado a mano no debe tocar el índice.
if (process.env.npm_lifecycle_event === 'version') {
  execFileSync('git', ['add', MANIFEST], { cwd: PROJECT, stdio: 'inherit' });
}
