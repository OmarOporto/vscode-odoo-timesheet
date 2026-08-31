# Odoo Timesheet

Extensión de VS Code que convierte tus commits diarios en líneas de horas en Odoo, sin salir del editor.

Un panel en la barra lateral con dos vistas: **tus commits agrupados por día** (leídos del repositorio local) y **tus tareas de Odoo**. Seleccionas commits, eliges la tarea, dices cuántas horas te llevó, y se crean las líneas en la hoja de horas.

## Requisitos

- VS Code 1.85 o superior
- Node.js 20+ y `git` en el PATH (solo para desarrollar)
- Una instancia de Odoo 15–18 con los módulos **Proyecto** y **Hojas de horas** instalados
- Tu usuario de Odoo debe tener una ficha de **Empleado** asociada: las hojas de horas la exigen

## Puesta en marcha

```bash
npm install
npm run watch     # esbuild en modo watch
```

Pulsa **F5** para abrir una ventana de desarrollo con la extensión cargada.

Para instalarla de forma permanente sin publicarla en el Marketplace:

```bash
npm run package                             # genera odoo-timesheet-0.1.0.vsix
code --install-extension odoo-timesheet-0.1.0.vsix
```

## Uso

1. **`Odoo: Conectar a Odoo`** (o el botón del panel). Pide URL, usuario, base de datos y contraseña.
2. La vista **Commits por día** se llena sola con tus commits del repositorio abierto.
3. Botón **+** sobre un día, un commit o una tarea → **Registrar horas**:
   - eliges los commits,
   - buscas la tarea (por nombre o por número),
   - decides si va **una línea por día** o **una línea por commit**,
   - escribes las horas y confirmas la descripción.

Las horas admiten `2.5`, `2,5` y `2:30`.

> Si seleccionas commits de varios días en modo agrupado, se crea **una línea por día**: registrar el trabajo del lunes con fecha de hoy falsearía la hoja de horas.

## Autenticación

La contraseña se guarda en el **SecretStorage** de VS Code (en Windows, el Administrador de credenciales), nunca en `settings.json`.

**Si tu cuenta de Odoo tiene verificación en dos pasos, la contraseña no sirve para la API.** Crea una API key en Odoo (*Preferencias → Seguridad de la cuenta → Nueva clave de API*) y úsala en lugar de la contraseña.

El **nombre de la base de datos** se intenta detectar solo. En Odoo Online el listado suele estar deshabilitado, así que se deduce del subdominio y, si no, se te pregunta.

## Ajustes

| Ajuste | Por defecto | Qué hace |
|---|---|---|
| `odooTimesheet.url` | — | URL base, p. ej. `https://miempresa.odoo.com` |
| `odooTimesheet.db` | — | Base de datos (vacío = detección automática) |
| `odooTimesheet.username` | — | Tu login de Odoo |
| `odooTimesheet.daysBack` | `14` | Días de historial de commits |
| `odooTimesheet.onlyMyCommits` | `true` | Filtra por tu `git config user.email` |
| `odooTimesheet.includeMerges` | `false` | Incluir commits de merge |
| `odooTimesheet.taskScope` | `assigned` | `assigned` (tus tareas) o `all` |
| `odooTimesheet.taskLimit` | `50` | Máximo de tareas por consulta |
| `odooTimesheet.allowInsecureTLS` | `false` | Acepta certificados no verificables (on-premise) |

Al buscar una tarea por nombre, si no hay coincidencias entre las tuyas se reintenta sobre todas: es normal imputar horas a una tarea que no tienes asignada.

## Cómo funciona por dentro

**Cero dependencias de runtime.** El bundle son ~29 KB de JavaScript propio.

- **Odoo** — JSON-RPC contra `POST {base}/jsonrpc`, la ruta que Odoo define en `odoo/addons/base/controllers/rpc.py` y que despacha a los mismos servicios que XML-RPC (`common.authenticate`, `object.execute_kw`). Sin XML, sin clientes HTTP externos. Se usa `node:https` en vez de `fetch` porque es la única forma de desactivar la verificación TLS *por petición*, sin tocar `NODE_TLS_REJECT_UNAUTHORIZED` global.
- **Versiones de Odoo** — en vez de ramificar por número de versión, al conectar se pregunta con `fields_get` si `project.task` tiene `user_ids` (Many2many, 16+) o `user_id` (Many2one, ≤15). El mismo código sirve de la 15 a la 18.
- **git** — la API de la extensión `vscode.git` solo se usa para *descubrir* el repositorio; los commits se leen con `git log` y separadores de control (`%x1f`, `%x1e`), que no se rompen con mensajes multilínea. El día de cada commit se recorta de `%aI` en lugar de recalcularse con `Date`, para que un commit de las 23:30 no salte al día siguiente.
- **Errores de Odoo** — las rutas `type='json'` responden HTTP 200 aunque fallen, con el error dentro del cuerpo. El cliente lo detecta y muestra el mensaje legible en vez del traceback de Python.

## Tests

```bash
npm test        # git contra un repositorio real + Odoo contra un servidor simulado
npm run check   # typecheck + build + test
```

`test/git.test.mjs` crea un repositorio de prueba y verifica el parseo (mensajes multilínea, correos con `+`, cambios de día por zona horaria, repositorio vacío). `test/odoo.test.mjs` levanta un servidor que imita a Odoo y verifica la forma exacta de los payloads, los dominios de búsqueda y el manejo de errores. Ninguno necesita credenciales reales.
