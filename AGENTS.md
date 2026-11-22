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
| `npm test` | jest + ts-jest (174 pruebas) |
| `npm run smoke` | pipeline de audio real: TTS -> OGG/Opus -> whisper.cpp -> texto |
| `npm run check:telegram` | valida el token del bot y avisa si hay webhook (incompatible con long polling) |
| `npm run check:agent` | ejecuta una orden real por el adaptador del agente (`AGENT`); `check:devin` es alias |
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
  iniciada. En una terminal normal esa variable no existe. `src/agents/devin/env.ts` la elimina antes de
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
  bandeja (fase actual + `active` + `recent` + `sessions`).
- `data/` y `vendor/` estan en `.gitignore`; el modelo `small` pesa ~465 MB.
- **Base de sesiones del CLI** (`%APPDATA%\devin\cli\sessions.db`): tablas `sessions`
  (`id`, `working_directory`, `created_at` y `last_activity_at` en **segundos**, `title`) y
  `message_nodes` (`session_id`, `chat_message` con JSON `{role, content}`). Se lee con `node:sqlite`
  (experimental, funciona sin flag en Node 22).
- **Las sesiones del IDE tambien estan en esa base** (`backend_type: windsurf`), con titulo y carpeta:
  no hay que mirar procesos. `src/core/sessionMonitor.ts` publica el estado y avisa cuando un turno
  termina (≈20 s sin actividad y ultimo mensaje del asistente). La primera lectura solo toma linea
  base y las sesiones del propio puente se excluyen por id (`SessionStore`).
- `live_row_times` y `tool_call_state` existen pero no son fiables para "en curso": se usa
  `last_activity_at` con ventana de 60 s.
- **Enrutado al IDE** (`DEVIN_ROUTE=auto`): `findProjectSession()` busca en `sessions.db` una sesion
  cuyo `working_directory` coincida con `DEVIN_WORKDIR` (rutas normalizadas, sin distinguir
  mayusculas) y que no sea del propio puente; si esta idle, la orden se ejecuta con
  `--resume <id>`. Verificado que `--resume <sesion-del-IDE> -p` funciona y escribe en esa sesion.
- **Enrutado al escritorio** (`DEVIN_ROUTE=desktop`, `scripts/send-to-desktop.ps1`): escribe en el
  compositor de la ventana del IDE con UI Automation. Datos comprobados:
  - Las ventanas de Devin Desktop se titulan `<carpeta> - Devin` (varias en un mismo proceso).
  - `ControlViewWalker` no expone el DOM; hay que usar **`RawViewWalker`**.
  - El compositor es un `ControlType.Edit` con `Name = 'Prompt'` y soporta `ValuePattern`, pero
    **no se usa para escribir**: `SetValue` deja el editor Slate desincronizado y el usuario luego no
    puede teclear. Se escribe **pegando con Ctrl+V** (evento real) tras verificar el foco.
  - **Nunca pisar un borrador**: si el compositor tiene texto (distinto del placeholder
    `Guia a Devin...`), el script aborta con `COMPOSITOR_OCUPADO`.
  - Tras el pegado el nodo UIA se recrea: la comprobacion de foco es **por tipo y nombre**, no por
    identidad (`Automation.Compare` da falso negativo).
  - **Nunca usar `SendKeys` a ciegas**: un `Ctrl+L` con el foco mal puesto acabo en la barra de
    direcciones de un Chromium. Solo se pulsa Enter tras verificar el texto y el foco.
  - **El boton del compositor cambia con el estado de la sesion**: idle = `Enviar` (deshabilitado si
    el compositor esta vacio); trabajando = `Detener Devin`. Ambos solo existen en el arbol **raw** y
    soportan `InvokePattern`.
  - **Con la sesion trabajando, Enter NO envia: encola** el mensaje dentro del IDE y el compositor se
    vacia (parece que borra la orden) dejando un trabajo en cola que no arranca. Por eso se comprueba
    `Detener Devin` antes de pegar y se aborta con `SESION_OCUPADA`; la orden cae al CLI.
  - **Se envia pulsando `Enviar`** (`InvokePattern`), no con Enter; Enter queda solo como ultimo
    recurso con el foco verificado. Enviado = el compositor vuelve a mostrar el placeholder.
  - **Windows no activa ventanas a un proceso en segundo plano**: `SetForegroundWindow` devuelve true
    sin cambiar nada y el `Ctrl+V` se pierde. Hay que inyectar un ALT (down/up) antes; verificado que
    es lo que desbloquea el primer plano.
  - **Nunca borrar el compositor ante un fallo**: si algo sale mal, la orden se queda escrita para
    que el usuario la envie a mano.
  - El valor del `ValuePattern` incluye el placeholder cuando esta vacio: comparar contra el texto
    enviado, no contra cadena vacia.
  - `-DryRun` detecta ventana y control; `-NoSubmit` pega y limpia (pruebas sin enviar).
  - `-ListWindows` devuelve JSON con `{project,title}` de cada ventana (`project` = texto antes de
    ` - Devin`). PowerShell 5.1 **no** soporta `ConvertTo-Json -AsArray`: usar
    `ConvertTo-Json -InputObject @($x)`.
  - **Enrutado por proyecto**: `matchProject()` (`src/agents/projectMatch.ts`) empareja el texto de la
    orden con los nombres de ventana (sin acentos ni mayusculas, palabras de 4+ caracteres). Si el
    proyecto mencionado no tiene ventana abierta, se comprueba contra los proyectos conocidos de
    `sessions.db` y se avisa **sin** caer en la ventana por defecto.

## Multiagente (Devin, OpenCode, Codex, Claude Code, OpenAI)

- **El nucleo no conoce agentes.** `src/core/bridge.ts` recibe `AgentCli`, `AgentDesktop` y
  `AgentSessions` (`src/agents/types.ts`); `src/agents/registry.ts` elige el adaptador segun
  `AGENT`. Anadir un agente = una carpeta en `src/agents/<nombre>/` + registrarlo. No se toca el
  flujo, la cola, Telegram ni la bandeja.
- **Config por agente.** `AGENT` elige; cada bloque (`config.agents.devin|opencode|codex|claude|openai`)
  tiene sus variables. `AGENT_WORKDIR|ROUTE|CONTINUITY|TIMEOUT_MS` mandan sobre los historicos
  `DEVIN_*`, que se siguen aceptando. `config.agent` es el bloque comun ya resuelto.
- **`AGENT_ROUTE=desktop` = la UI de ese agente**: la ventana de Devin Desktop para Devin, la
  terminal integrada del IDE para las TUI. `openai` no tiene UI: siempre va por API.

### Hechos comprobados por agente

- **OpenCode** (probado 1.15.4): `opencode run [--session <id>|--continue] [--model p/m] [--agent a]
  [--dangerously-skip-permissions] -- "<orden>"`. El `--` es necesario para que una orden que empiece
  por `-` no se lea como flag. **No imprime el id de sesion**: se recupera de su base
  (`~/.local/share/opencode/opencode.db`, tabla `session.directory` + `time_updated`).
  Esquema: `session`, `message.data` (JSON con `role`), `part.data` (JSON; el texto es
  `{type:'text', text}`). El plan gratuito exige >= 1.18 y **el error se imprime en stdout con codigo
  0**: por eso `friendlyOpenCodeError()` mira el texto, no el codigo de salida.
- **Codex**: `codex exec [flags] [resume <id>|resume --last] -- "<orden>"`. Los flags van **entre
  `exec` y `resume`** (el parser no los acepta despues). Sesiones: `~/.codex/sessions/**/*.jsonl`;
  la primera linea es `session_meta` con `{id, cwd}` y los mensajes son `response_item` con
  `payload.type='message'` y `content[].text`. No instalado en esta maquina: sin verificar en real.
- **Claude Code**: `claude -p --output-format json [--resume <id>|--continue] [--permission-mode m]
  -- "<orden>"`. La salida JSON trae `result`, `session_id` e `is_error`. Transcripciones en
  `~/.claude/projects/<proyecto>/<session-id>.jsonl` (`type`, `sessionId`, `cwd`,
  `message.content`). No instalado: sin verificar en real.
- **OpenAI API**: `POST <base>/chat/completions`, compatible con servidores locales (LM Studio,
  Ollama, OpenRouter). Historial en memoria por sesion: se pierde al reiniciar. No ejecuta
  herramientas ni toca el repositorio.
- **Terminal integrada** (`scripts/send-to-terminal.ps1`): la terminal **no esta** en el arbol de
  control; se busca en el raw por clase `xterm*` o nombre `*Terminal*` y **exige** que coincida con
  `-Expect` (patron por agente) antes de pegar. xterm no expone su contenido por UI Automation: no se
  puede verificar lo escrito, solo el foco. Sin terminal abierta no hay nada que probar: pendiente de
  validacion real.

### Procesos: verlos y detenerlos

- **El pid se registra al lanzar.** `runCommand` acepta `onSpawn(pid)`; los adaptadores lo reenvian y
  `CommandBridge` lo guarda en `ProcessRegistry` (con la orden y el chat) y lo quita en el `finally`
  de la tarea. `status.json` publica esos procesos en `processes`.
- **Los de fuera del puente se leen con CIM** (`listExternalAgentProcesses`). El emparejamiento lo
  calcula `agentProcessMatchers()`: si el binario es una ruta absoluta se compara `ExecutablePath`;
  si es solo un nombre (esta en el PATH) se compara el nombre.
- **Nunca se lista `Devin.exe` de la app de escritorio.** Se llama igual que el CLI y matarla rompe
  el IDE: ademas de emparejar por ruta exacta, se filtra cualquier ejecutable bajo `\programs\devin\`.
- **PowerShell `-Command` exige sentencias separadas por saltos de linea.** Unirlas con espacios da
  "Token inesperado" y el script falla con codigo 1 (silencioso si no se mira el codigo).
- **Solo se detienen pids de la lista.** `stopProcess(pid)` comprueba que el pid este en
  `listProcesses()` antes de `taskkill /T /F`: un callback de Telegram no puede matar cualquier cosa.
- **Telegram**: `/procesos` y la pregunta de lentitud (`isDelayQuestion`: sin acentos y mensaje de
  60 caracteres como maximo, para no secuestrar ordenes) muestran el listado con botones
  `proc:stop:<pid>` y `proc:list`. La allowlist del middleware tambien cubre los callbacks.
- **Bandeja**: el panel tiene el grupo "Procesos del agente en marcha" con `$item.Tag = pid` y el
  boton "Detener proceso" (pide confirmacion). La consulta CIM se cachea 5 s para no refrescar el
  panel cada 2 s con una consulta lenta.

## Convenciones del proyecto

- **Instancia unica obligatoria.** `src/index.ts` toma `data/bridge.lock` (PID) antes de arrancar.
  Dos puentes con el mismo token hacen `409 Conflict` en Telegram. Cualquier punto de entrada nuevo
  debe respetar ese candado; la bandeja comprueba el estado leyendo el lock, no con un handle propio.
- La bandeja (`scripts/tray.ps1`) lanza el puente como `node --import tsx src/index.ts` y lo mata con
  `taskkill /T /F`. No usa ventana de consola: el log vive en `data/logs/`.
- **Los resumenes de Telegram no son la salida completa.** `summarizeMessage()` (`src/core/sessionDigest.ts`)
  conserva el principio y el final del mensaje, con `…` marcando el hueco: la conclusion de lo que hizo
  el modelo esta al final. Se usa en `buildSummary()` y en el aviso de sesiones. No truncar solo por el
  principio.
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
