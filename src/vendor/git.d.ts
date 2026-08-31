/**
 * Tipos mínimos de la API pública de la extensión integrada `vscode.git`.
 *
 * No se publica en `@types/vscode`, así que se declara aquí solo lo que usamos:
 * descubrir las raíces de los repositorios y enterarnos cuando abren o cierran
 * uno. La lectura de commits NO pasa por aquí (va por `git log`), justamente
 * para no depender de partes menos estables de esta API.
 */
import type { Event, Uri } from 'vscode';

export interface GitExtension {
  getAPI(version: 1): API;
}

export interface API {
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
}

export interface Repository {
  readonly rootUri: Uri;
}
