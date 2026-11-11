# AGENTS.md

Puente de voz Telegram -> agente de codigo local (por defecto Devin CLI) -> resumen (texto + audio).
Node 22 + TypeScript (CommonJS). Windows para TTS y bandeja; el resto es portable.

## Comandos

| Comando | Uso |
|---|---|
| `npm start` | arranca el puente (bot en long polling) |
| `npm run dev` | igual, con recarga al guardar |
| `npm run demo` | pipeline completo con mocks, sin credenciales ni dependencias |
| `npm run tray:start` | lanza el gestor de bandeja sin consola (arranca el puente) |
| `npm run tray` | bandeja en primer plano (depuracion) |
| `npm run tray:dashboard` | bandeja con el panel de actividad abierto |
| `npm run tray:test` | self-test de la bandeja: arranca, comprueba PID, detiene |
| `npm run tray:lint` | valida la sintaxis de `scripts/tray.ps1` |
| `npm run tray:install` / `tray:uninstall` | alta/baja del arranque con Windows |
| `npm run typecheck` | `tsc --noEmit` (obligatorio antes de dar algo por terminado) |
| `npm test` | jest + ts-jest (101 pruebas) |
| `npm run smoke` | pipeline de audio real: TTS -> OGG/Opus -> whisper.cpp -> texto |
| `npm run check:telegram` | valida el token del bot y avisa si hay webhook (incompatible con long polling) |
| `npm run check:devin` | ejecuta una orden real por el mismo runner que usa el bot |
| `npm run setup:whisper` | descarga whisper.cpp + modelo (`-- -Model medium` para otro) |

## Verificacion minima antes de cerrar un cambio

1. `npm run typecheck`
2. `npm test`
3. Si se toco audio: `npm run smoke`
4. Si se toco `scripts/tray.ps1`: `npm run tray:lint` (un error de sintaxis hace que la bandeja
   arranque y muera en silencio: se lanza oculta por wscript y no hay consola que lo cuente)

## Hechos del entorno (comprobados, no asumir otra cosa)

- **`ACP_BACKEND=windsurf` rompe la autenticacion.** La app de escritorio de Devin la exporta a sus
  hijos; con ella el CLI usa el backend de Windsurf y responde `Not logged in` aunque la sesion este
  iniciada. En una terminal normal esa variable no existe. `src/devin/env.ts` la elimina antes de
  lanzar el CLI. Si vuelve a decir "Not logged in", comprobar esto ANTES de rehacer el login.
- **Los flags van antes de `--`.** `--` corta el analisis de opciones: lo que se ponga despues se
  interpreta como texto de la orden, asi que `--permission-mode` o `--respect-workspace-trust` ahi
  se ignoran en silencio. Hay un test de regresion que lo cubre.
- **Workspace no confiable.** En modo `-p` no hay prompt de confianza y el CLI aborta. Se resuelve con
  `--respect-workspace-trust false` (bien colocado) o con `respect_workspace_trust: false` en config.
- **El session id se obtiene del `--export`** (ATIF): `extractSessionId()` busca `session_id`/
  `trajectory_id` en el JSON. Devuelve ids tipo `brisk-otter`. Si no aparece, se cae a `--continue`,
  que reanuda la ultima sesion de esa carpeta.
- **Devin CLI** no esta en el PATH de los shells ya abiertos. Instalador oficial:
  `irm https://static.devin.ai/cli/setup.ps1 | iex`; el binario queda en
  `%LOCALAPPDATA%\devin\cli\bin\devin.exe`. `config.ts` lo resuelve ahi.
- El binario `devin-desktop.cmd` de la app de escritorio **no** acepta `--print`: es otra cosa.
- **Sin sesion iniciada, `devin -p` no falla: se cuelga** esperando el login. De ahi el preflight
  `devin auth status` en `DevinRunner.ensureAuthenticated()` (cache 60 s).
- El login del CLI es interactivo (menu TUI): en Windows no se puede completar desde un shell sin TTY.
- Modo no interactivo = nadie aprueba permisos. Por eso el default es `dangerous` (bypass).
- `devin --print` acepta prompt inline, pero usamos `--print -- "<prompt>"` para que una orden que
  empiece por `-` no se lea como flag.
- `whisper-bin-x64.zip` (tag `v1.9.2`) descomprime en una **subcarpeta `Release/`**; el setup la aplana
  porque el `.exe` necesita sus DLL al lado.
- Flags de whisper.cpp verificados: `-m -f -l -t -np -nt -otxt -of`.
- El TTS necesita un `ffmpeg` con `libopus` (las builds habituales lo traen).
- TTS: `System.Speech` via `powershell.exe` (Windows PowerShell 5.1, no `pwsh`). La voz depende de las
  que tenga instaladas el sistema; `/voices` las lista.
- `grammy` 1.46 funciona en CJS (`require('grammy')`); no exporta `Update` desde la raiz.
- La bandeja usa WinForms (`NotifyIcon`) desde `powershell.exe`, que en Windows PowerShell 5.1 ya
  corre en STA: no hace falta `-STA`. El arranque sin consola va por `wscript` + `scripts/tray.vbs`.
- **`NotifyIcon.Text` lanza excepcion si pasa de 63 caracteres** (no trunca). `Limit-Text` recorta a
  `Max` contando los puntos suspensivos. Ademas, cualquier excepcion en el timer de la bandeja abre un
  modal de .NET: todos los handlers van con try/catch y el tick escribe en `tray.log` si falla.
- **Los scriptblocks de eventos/timers no ven variables locales de la funcion que los crea.** Los
  controles del panel se guardan en `$script:` (`$script:dashList`, etc.) o el refresco falla con
  "La propiedad 'Text' no se encuentra en este objeto".
- PowerShell 5.1 no tiene operador ternario (`? :`): usar if/else.
- El historial de tareas (`TaskRegistry`) es en memoria; `data/status.json` es la unica interfaz con la
  bandeja (fase actual + `active` + `recent`).
- El panel lista tambien procesos reales (`Get-DevinProcesses`): solo el **proceso principal** de
  `...\Programs\Devin\Devin.exe` y los `...\devin\cli\bin\devin.exe`. Los subprocesos de Chromium del
  IDE (`--type=renderer`, `--type=gpu-process`, `--require=...`) se descartan: sin ese filtro salen
  mas de 30 filas de ruido. Las sesiones de Devin Desktop y Cloud **no** son procesos locales, asi
  que no aparecen ahi.
- `data/` y `vendor/` estan en `.gitignore`; el modelo `small` pesa ~465 MB.
- **Base de sesiones del CLI** (`%APPDATA%\devin\cli\sessions.db`): tablas `sessions`
  (`id`, `working_directory`, `created_at` y `last_activity_at` en **segundos**, `title`) y
  `message_nodes` (`session_id`, `chat_message` con JSON `{role, content}`). Se lee con `node:sqlite`
  (experimental, funciona sin flag en Node 22) para resumir tareas externas. `devin.exe` lanza un
  proceso hijo que tambien coincide con el filtro: se descarta por relacion padre-hijo o la tarea
  se contaria dos veces.
- Las sesiones de Devin Desktop y Cloud no son procesos locales: no aparecen ni generan avisos.

## Convenciones del proyecto

- **Instancia unica obligatoria.** `src/index.ts` toma `data/bridge.lock` (PID) antes de arrancar.
  Dos puentes con el mismo token hacen `409 Conflict` en Telegram. Cualquier punto de entrada nuevo
  debe respetar ese candado; la bandeja comprueba el estado leyendo el lock, no con un handle propio.
- La bandeja (`scripts/tray.ps1`) lanza el puente como `node --import tsx src/index.ts` y lo mata con
  `taskkill /T /F`. No usa ventana de consola: el log vive en `data/logs/`.
- Textos de usuario (mensajes del bot, errores, README) en **español sin tildes en identificadores**;
  el codigo y los nombres de API en ingles.
- Comentarios solo donde explican *por que*, no *que*.
- `src/core/bridge.ts` no conoce Telegram: recibe un `Notifier`. Cualquier canal nuevo (WhatsApp)
  debe implementar ese contrato y reutilizar el resto.
- Procesos externos siempre via `src/util/process.ts` (`spawn` sin shell, timeout con `taskkill /T`).
- La allowlist de Telegram es parte de la seguridad: con la lista vacia el bot **no ejecuta nada**,
  solo devuelve el user id. No relajar esa comprobacion.
- Nada de datos reales en el repo: tokens, ids, rutas de usuario y logs van fuera (`.env`, `data/`).
  Los ejemplos y las pruebas usan mocks (`src/mocks/`).
