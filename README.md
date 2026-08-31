# Odoo Timesheet

Extensión de VS Code que convierte tus commits diarios en líneas de horas en Odoo, sin salir del editor.

Un panel en la barra lateral con dos vistas: **tus commits agrupados por día** (leídos del repositorio local) y **tus tareas de Odoo**. Seleccionas commits, eliges la tarea, dices cuántas horas te llevó, y se crean las líneas en la hoja de horas.

## Requisitos

- VS Code 1.85 o superior
- Node.js 20+ y `git` en el PATH (solo para desarrollar)
- Una instancia de Odoo 15–18 con los módulos **Proyecto** y **Hojas de horas** instalados
- Tu usuario de Odoo debe tener una ficha de **Empleado** asociada: las hojas de horas la exigen

## Instalarla

### Desde un release (lo más rápido)

Este comando instala **y actualiza** a la última versión. La URL es permanente:

```bash
curl -L -o /tmp/ots.vsix https://github.com/OmarOporto/vscode-odoo-timesheet/releases/latest/download/odoo-timesheet.vsix \
  && code --install-extension /tmp/ots.vsix --force \
  && rm /tmp/ots.vsix
```

Después, recarga la ventana: `Ctrl+Shift+P` → *Developer: Reload Window*.

También puedes bajar el `.vsix` a mano desde la [página de releases](https://github.com/OmarOporto/vscode-odoo-timesheet/releases) y usar `Ctrl+Shift+P` → **«Extensions: Install from VSIX…»**.

> Instalada desde un `.vsix`, **VS Code no busca actualizaciones**: no hay aviso ni insignia de «Update». Hay que volver a ejecutar el comando de arriba. Sobrescribe la versión anterior; no hace falta desinstalar nada.

### Desde el código

```bash
npm install
npm run install-local
```

Eso la empaqueta y la instala en tu VS Code. A partir de ahí está disponible **en cualquier ventana y cualquier carpeta**, sin F5.

### En WSL

VS Code trata esta extensión como *workspace extension* (lo es: necesita ver tu repositorio y tu `git`), así que en una ventana de WSL corre **del lado de WSL**. Por eso hay que instalarla ahí:

```bash
# desde una shell de WSL, en la carpeta del proyecto
npm run install-local
```

O desde la UI: busca la extensión en el panel de Extensiones y pulsa **«Install in WSL»**.

Tu API key **no** hay que volver a escribirla: VS Code guarda los secretos siempre del lado del cliente, así que sigue en el Administrador de credenciales de Windows aunque la extensión corra en WSL.

## Desarrollo

```bash
npm run watch     # esbuild en modo watch
```

Para publicar una versión, **usa siempre `npm version`**:

```bash
npm version patch && git push --follow-tags
```

El hook `version` de npm sincroniza `displayName` («Odoo Timesheet 0.1.2») dentro del mismo commit, y el workflow de release rechaza publicar si los dos números no coinciden.

**F5** abre una ventana de desarrollo. Hay dos configuraciones:

- **Ejecutar extensión** — abre la última carpeta que usaras.
- **Ejecutar extensión en otra carpeta…** — te pregunta la ruta y abre esa. Útil porque el propio repo de la extensión puede no tener el historial que quieres probar.

## Uso

1. **`Odoo: Conectar a Odoo`** (o el botón del panel). Con Odoo 19 basta la URL y una API key.
2. La vista **Commits por día** se llena sola con tus commits del repositorio abierto.
3. La vista **Tareas de Odoo** muestra tus **proyectos**; al desplegar uno se cargan sus tareas.
4. Botón **+** sobre un día, un commit, un proyecto o una tarea → **Registrar horas**:
   - eliges los commits,
   - eliges **con qué fecha** registrarlos: hoy, la del commit, u otra,
   - eliges el proyecto (se salta si ya venías de uno, o si tienes uno fijado),
   - buscas la tarea por nombre o número, **o creas una nueva** con `➕ Crear tarea nueva…`,
   - decides si va **una línea por día** o **una línea por commit**,
   - escribes las horas y confirmas la descripción.

La tarea nueva se propone con la fecha del día y los mensajes de commit (`08/30 fix login redirect; add user guard`) y **se te asigna**, para que luego aparezca en el panel sin depender del filtro.

Las horas admiten `2.5`, `2,5` y `2:30`.

La descripción se propone con el **mensaje completo** de cada commit —título y cuerpo, colapsado a una línea— recortado a 1000 caracteres. Es solo la sugerencia: lo que se guarda es lo que dejes en la caja, y Odoo no impone ningún límite (`account.analytic.line.name` es un `Char` sin `size`).

**Fijar un proyecto** (icono 📌 sobre el proyecto, o `Odoo: Elegir proyecto`) deja el panel en lista plana con solo esas tareas, y hace que el flujo de registro se salte el paso de proyecto. Se guarda en `settings.json`, así que sobrevive a reinicios.

**La fecha** se pregunta solo cuando aporta algo: si todos los commits son de hoy, el paso se salta. Si prefieres no decidirlo cada vez, `odooTimesheet.lineDate` acepta `today` o `commit` y el diálogo desaparece.

> Cuidado con una consecuencia: si eliges **una fecha única** para commits de varios días, el modo agrupado crea **una sola línea** con todo — dos líneas con la misma fecha y la misma tarea no aportarían nada. Con **la fecha del commit** sí se crea una línea por día.

## Autenticación

La contraseña o API key se guarda en el **SecretStorage** de VS Code (en Windows, el Administrador de credenciales), nunca en `settings.json`.

**Odoo 19 y superior necesitan una API key.** Créala en *Preferencias → Seguridad de la cuenta → Nueva clave de API* y pégala donde se pide la contraseña. En versiones anteriores la contraseña sirve, salvo que la cuenta tenga verificación en dos pasos.

Con la API nueva (JSON-2) **basta la URL y la API key**: la propia key identifica al usuario y la base de datos. Solo si hay que caer a la API antigua se te piden la base de datos y el usuario. El nombre de la base se intenta detectar solo; en Odoo Online el listado suele estar deshabilitado, así que se deduce del subdominio y, si no, se te pregunta.

Puedes pegar **cualquier URL de Odoo** al conectar, incluida la de una tarea (`https://…/odoo/timesheets/project.task/2488`): se recorta sola hasta la base.

## Dónde se configura

Tres formas de tocar los ajustes, de más cómoda a más directa:

1. **UI** — `Ctrl+,` y buscar `odooTimesheet`. O el comando **`Odoo: Abrir ajustes`**.
2. **Tu `settings.json` de usuario** — comando **`Odoo: Editar settings.json`**, o a mano en:
   ```
   %APPDATA%\Code\User\settings.json
   ```
   que en tu equipo se expande a `C:\Users\<usuario>\AppData\Roaming\Code\User\settings.json`.
3. **Por proyecto** — `.vscode/settings.json` dentro del workspace. **Tiene prioridad** sobre el de usuario, útil si trabajas contra dos instancias de Odoo distintas.

Bloque completo listo para pegar:

```jsonc
{
  "odooTimesheet.url": "https://miempresa.odoo.com",
  "odooTimesheet.username": "tu@correo.com",
  "odooTimesheet.db": "",              // vacío = detección automática
  "odooTimesheet.api": "auto",         // auto | json2 | jsonrpc
  "odooTimesheet.daysBack": 14,
  "odooTimesheet.onlyMyCommits": true,
  "odooTimesheet.includeMerges": false,
  "odooTimesheet.taskScope": "assigned",
  "odooTimesheet.taskLimit": 50,
  "odooTimesheet.projectId": 0,        // 0 = todos los proyectos
  "odooTimesheet.projectName": "",     // solo informativo
  "odooTimesheet.allowInsecureTLS": false
}
```

> La contraseña / API key **no aparece aquí a propósito**. Es el único dato que no vive en un archivo: está en el almacén de secretos del sistema. Para cambiarla, usa **`Odoo: Cambiar contraseña o API key`**.

¿No sabes de dónde está saliendo un valor? **`Odoo: Mostrar registro de diagnóstico`** vuelca cada ajuste con su ámbito (`por defecto`, `usuario: settings.json`, `workspace: .vscode/settings.json`).

## Ajustes

| Ajuste | Por defecto | Qué hace |
|---|---|---|
| `odooTimesheet.url` | — | URL base, p. ej. `https://miempresa.odoo.com` |
| `odooTimesheet.repositoryPath` | — | Vacío = automático · `*` = todos · una ruta absoluta |
| `odooTimesheet.db` | — | Base de datos (vacío = detección automática; opcional en JSON-2) |
| `odooTimesheet.username` | — | Tu login de Odoo (se rellena solo con JSON-2) |
| `odooTimesheet.api` | `auto` | `auto`, `json2` o `jsonrpc` |
| `odooTimesheet.daysBack` | `14` | Días de historial de commits |
| `odooTimesheet.onlyMyCommits` | `true` | Filtra por tu `git config user.email` |
| `odooTimesheet.includeMerges` | `false` | Incluir commits de merge |
| `odooTimesheet.taskScope` | `mine` | `mine`, `assigned`, `timesheet` o `all` |
| `odooTimesheet.lineDate` | `ask` | `ask`, `today` o `commit` |
| `odooTimesheet.taskOrder` | `created` | `created`, `updated` o `name` |
| `odooTimesheet.tasksPerProject` | `10` | Tareas por proyecto antes de «Mostrar más» |
| `odooTimesheet.taskLimit` | `50` | Máximo de tareas en las **búsquedas** |
| `odooTimesheet.taskNameDateFormat` | `MM/DD` | Prefijo de fecha al crear tareas |
| `odooTimesheet.assignNewTasksToMe` | `true` | Autoasignarte las tareas que crea la extensión |
| `odooTimesheet.diagnosticsDays` | `60` | Ventana que revisa el diagnóstico |
| `odooTimesheet.projectId` | `0` | Proyecto fijado en el panel (`0` = todos) |
| `odooTimesheet.projectName` | — | Nombre del proyecto fijado, solo informativo |
| `odooTimesheet.allowInsecureTLS` | `false` | Acepta certificados no verificables (on-premise) |

Al buscar una tarea por nombre, si no hay coincidencias entre las tuyas se reintenta sobre todas: es normal imputar horas a una tarea que no tienes asignada.

## ¿No aparece una tarea?

**`Odoo: Diagnosticar tareas que faltan`** lo responde. Parte de tus imputaciones reales en Odoo —que por definición son las tareas que deberías estar viendo— y descarta causas en orden hasta dar con la que la esconde:

```
✗ #2488 08/29 Fix Alejandro Bridge. Completion P2P integration
    proyecto: DEV EQUIPO · 4 h · última imputación 2026-08-29
    → el filtro odooTimesheet.taskScope = "assigned" la excluye: la tarea no
      tiene a nadie en Asignados, y registrar horas no te asigna a ella
```

Esa es la trampa principal: **`user_ids` («Asignados») e imputar horas son cosas independientes**. Una tarea creada al vuelo escribiendo su nombre en la rejilla de hojas de horas nace sin asignados, así que `taskScope: "assigned"` la esconde. Por eso el valor por defecto es `mine`, que suma ambos criterios.

El comando también detecta tareas archivadas, proyectos con las hojas de horas desactivadas, tareas fuera de `taskLimit` y falta de permisos.

## Cómo funciona por dentro

**Cero dependencias de runtime.** El bundle es JavaScript propio, sin librerías.

- **Dos APIs de Odoo.** La 19 estrenó **JSON-2** (`POST {base}/json/2/<modelo>/<método>`, `Authorization: bearer <api-key>`, parámetros nombrados) y marcó `/xmlrpc`, `/xmlrpc/2` y `/jsonrpc` como deprecados, *«scheduled for removal in Odoo 22 (fall 2028)»*. La extensión sondea JSON-2 al conectar y cae a **JSON-RPC** (`POST {base}/jsonrpc`, `common.authenticate` + `object.execute_kw`) cuando la instancia es anterior o la credencial no es una API key. `odooTimesheet.api` fuerza uno u otro.
  - La interfaz interna común usa **parámetros nombrados** (el estilo de JSON-2) y el transporte antiguo los traduce a posicionales — la dirección fácil de la traducción.
  - Se usa `node:https` en vez de `fetch` porque es la única forma de desactivar la verificación TLS *por petición*, sin tocar `NODE_TLS_REJECT_UNAUTHORIZED` global.
- **Versiones de Odoo** — en vez de ramificar por número de versión, al conectar se pregunta con `fields_get` si `project.task` tiene `user_ids` (Many2many, 16+) o `user_id` (Many2one, ≤15), y si `project.project` expone `task_count`. El mismo código sirve de la 15 a la 19.
- **URLs** — a partir de Odoo 17 los registros se abren como `/odoo/<modelo>/<id>` (funciona porque el nombre del modelo lleva punto, que es como el router distingue un modelo de una acción); antes, con el hash del cliente viejo.
- **git** — la API de la extensión `vscode.git` solo se usa para *descubrir* repositorios; los commits se leen con `git log` y separadores de control (`%x1f`, `%x1e`), que no se rompen con mensajes multilínea. El día de cada commit se recorta de `%aI` en lugar de recalcularse con `Date`, para que un commit de las 23:30 no salte al día siguiente.
- **Sin `--since`, a propósito.** El walker de git poda la travesía en cuanto encuentra un commit más viejo que el corte, así que un HEAD con fecha antigua (un rebase que conserva fechas, un cherry-pick, un reloj mal puesto) hace que `git log --since` devuelva **cero commits en silencio**. Se leen los últimos 5000 y se recorta por fecha en JS — que además usa la fecha de *autor*, la misma con la que se agrupa, en vez de la de *commit* que mira `--since`.
- **Errores de Odoo** — las rutas `type='json'` responden HTTP 200 aunque fallen, con el error dentro del cuerpo. El cliente lo detecta y muestra el mensaje legible en vez del traceback de Python.

## Tests

```bash
npm test        # git contra un repositorio real + Odoo contra un servidor simulado
npm run check   # typecheck + build + test
```

`test/git.test.mjs` crea un repositorio de prueba y verifica el parseo (mensajes multilínea, correos con `+`, cambios de día por zona horaria, repositorio vacío).

`test/odoo.test.mjs` levanta un servidor que imita a Odoo **por las dos APIs** y ejecuta las mismas aserciones de negocio contra ambos transportes, además de la forma exacta del cable (bearer, `X-Odoo-Database`, `vals_list`, orden de `execute_kw`), la detección y caída entre APIs, y el manejo de errores.

Ninguno de los dos necesita credenciales reales.
