/**
 * Empaqueta la extensión e instala el .vsix resultante en el VS Code de esta
 * máquina — o de este WSL, si se ejecuta desde una shell de WSL, que es
 * justamente lo que hace falta para que la extensión vea los repositorios de
 * WSL.
 *
 *   npm run install-local
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

function run(command, args) {
  execFileSync(command, args, { cwd: PROJECT, stdio: 'inherit', shell: isWindows });
}

run('npm', ['run', 'package']);

// Se busca el .vsix más reciente en vez de codificar la versión, para que esto
// no se rompa cada vez que se sube el número.
const vsix = fs
  .readdirSync(PROJECT)
  .filter((name) => name.endsWith('.vsix'))
  .map((name) => ({ name, mtime: fs.statSync(path.join(PROJECT, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)[0];

if (!vsix) {
  console.error('No se encontró ningún .vsix. ¿Falló el empaquetado?');
  process.exit(1);
}

console.log(`\nInstalando ${vsix.name}…`);
try {
  run('code', ['--install-extension', path.join(PROJECT, vsix.name), '--force']);
} catch {
  console.error(
    '\nNo se pudo ejecutar «code». En Windows, reinstala VS Code marcando «Añadir a PATH».' +
      '\nEn WSL, abre una carpeta en WSL desde VS Code una vez para que se instale el comando.',
  );
  process.exit(1);
}

console.log('\nListo. Recarga las ventanas de VS Code para que tome la versión nueva.');
