# ConnectAgentToTelegram

Puente de voz entre Telegram y un agente de código que corre en tu ordenador (por defecto
[Devin CLI](https://devin.ai)): mandas una **nota de voz**, se transcribe en local, se ejecuta como
orden para el agente y recibes el **resumen de vuelta por texto y por audio**.

```
Telegram (nota de voz)  ->  OGG/Opus  ->  ffmpeg  ->  whisper.cpp (local)  ->  texto
                                                                             |
                                                          devin --print -- "<orden>"
                                                                             |
                       Telegram (texto + nota de voz)  <-  resumen  <-  TTS local
```

El audio no sale de tu máquina: la transcripción y la síntesis son locales. Solo la orden (texto)
llega al modelo, igual que si la escribieras en la terminal.

## Características

- **Manos libres**: dictas desde el móvil y el agente trabaja en tu PC.
- **Multiagente**: Devin, OpenCode, Codex, Claude Code o la API de OpenAI, con el mismo bot y la
  misma bandeja. Se elige con `AGENT` y cada uno tiene su propio bloque de configuración.
- **Transcripción local** con whisper.cpp (sin APIs de terceros).
- **Respuesta en audio** con las voces de Windows (System.Speech) y conversión a OGG/Opus.
- **Hilo de conversación por chat**: cada chat mantiene su sesión del agente (`--resume`).
- **Cola por chat**: si mandas varias órdenes seguidas, se ejecutan en orden y te avisa de la posición.
- **Sesiones del agente a la vista**: el puente lee el almacén de sesiones del agente y muestra en el
  panel todas las recientes (del IDE y del CLI) con su estado; cuando una termina su turno, te
  avisa por Telegram **con el resumen de lo que hizo**.
- **Bandeja del sistema**: icono con estado, panel de actividad (doble clic) y control de
  iniciar / detener / reiniciar. Arranque automático con Windows.
- **Instancia única**: dos procesos con el mismo token provocarían `409 Conflict` en Telegram.
- **Modo demo con mocks** para probarlo todo sin cuenta de agente ni credenciales.

## Requisitos

| Pieza | Necesario | Nota |
|---|---|---|
| Node.js >= 20.11 | Sí | Probado con Node 22 |
| ffmpeg en el PATH | Sí | Necesita `libopus` (las builds habituales lo traen) |
| Un agente instalado y autenticado | Sí (salvo modo demo) | Devin, OpenCode, Codex, Claude Code o una API key de OpenAI |
| whisper.cpp + modelo | Se descarga | `npm run setup:whisper` (~490 MB el modelo `small`) |
| Windows | Solo para TTS y bandeja | El resto (bot, transcripción, cola) es portable |

## Instalación

```bash
git clone https://github.com/<tu-usuario>/ConnectAgentToTelegram.git
cd ConnectAgentToTelegram
npm install
npm run setup:whisper          # descarga whisper.cpp y el modelo ggml-small
```

Si vas a usar un agente real, instala su CLI y autentícalo una vez:

```powershell
# Devin
irm https://static.devin.ai/cli/setup.ps1 | iex
devin auth login

# OpenCode
npm i -g opencode-ai
opencode auth login

# Codex (OpenAI)
npm i -g @openai/codex
codex login

# Claude Code
npm i -g @anthropic-ai/claude-code
claude
```

La API de OpenAI no necesita CLI: basta `OPENAI_API_KEY`.

## Agentes: uno a la vez, mismo puente

El agente se elige con `AGENT` (`devin` por defecto). El núcleo no conoce a ninguno en concreto:
habla con tres puertos (`src/agents/types.ts`) y cada agente aporta su adaptador.

| `AGENT` | Ejecuta | Reanuda | Sesiones para el panel | Escribe en la UI |
|---|---|---|---|---|
| `devin` | `devin --print` | `--resume` / `--continue` | `sessions.db` del CLI (IDE + CLI) | Ventana de Devin Desktop (UI Automation) |
| `opencode` | `opencode run` | `--session` / `--continue` | `opencode.db` (`session`, `message`, `part`) | Terminal integrada del IDE |
| `codex` | `codex exec` | `exec resume <id>` / `--last` | rollouts `.jsonl` de `~/.codex/sessions` | Terminal integrada del IDE |
| `claude` | `claude -p --output-format json` | `--resume` / `--continue` | transcripciones de `~/.claude/projects` | Terminal integrada del IDE |
| `openai` | `POST /chat/completions` | hilo en memoria | — | — |

Tres ideas que conviene tener claras:

1. **`AGENT_ROUTE=desktop` significa "la UI de ese agente"**: la ventana de Devin Desktop para Devin
   y la **terminal integrada del IDE** para las TUI de OpenCode, Codex y Claude Code.
2. **La terminal es opt-in y va con guardas.** No se escribe si el terminal no se identifica con
   `OPENCODE_TERMINAL_PATTERN` / `CODEX_TERMINAL_PATTERN` / `CLAUDE_TERMINAL_PATTERN` (por defecto el
   nombre del agente). Aun así es la ruta más frágil: xterm no expone su contenido, así que no se
   puede verificar lo escrito. Para el día a día, `AGENT_ROUTE=auto` (reanudar la sesión) es lo
   recomendado.
3. **`openai` no es un agente de código**: no tiene herramientas ni acceso al repositorio; es una
   conversación. Sirve para preguntas, no para "arréglame el bug". Su historial vive en memoria y se
   pierde al reiniciar el puente.

```bash
# Ejemplos
AGENT=opencode npm start
AGENT=claude AGENT_ROUTE=auto npm start
AGENT=openai OPENAI_API_KEY=sk-... npm start
npm run check:agent -- "responde solo OK"   # prueba el agente configurado
```

## Pruébalo en 30 segundos (sin credenciales)

```bash
npm run demo
```

Recorre el mismo pipeline que el bot (transcripción → orden → resumen) con **mocks**: no llama a
ningún modelo, no usa Telegram y no necesita whisper. Sirve para ver el flujo y para desarrollar.

Salida esperada:

```
[BOT] 🎧 Audio recibido, transcribiendo...
[BOT] 🎧 Entendi en 1s: "Revisa el README del proyecto..."
[BOT] ✅ Listo en 2s
      Respuesta simulada: ...
      🟢 Esperando nuevas ordenes.
```

Para probar el bot real pero con respuestas simuladas, pon `MOCK_MODE=true` en `.env`: el bot de
Telegram, la cola, el TTS y la bandeja funcionan, pero ni whisper ni el agente se ejecutan.

## Puesta en marcha

1. **Crea el bot**: habla con [@BotFather](https://t.me/BotFather) en Telegram, `/newbot`, y copia
   el token.
2. **Configura**:
   ```bash
   cp .env.example .env
   ```
   ```ini
   TELEGRAM_BOT_TOKEN=123456789:AA...   # el que te dio BotFather
   TELEGRAM_ALLOWED_USER_IDS=           # se rellena en el paso 4
   ```
3. **Arranca**: `npm start`
4. **Autorízate**: escribe cualquier cosa al bot. Como la allowlist está vacía, no ejecutará nada y
   te responderá con **tu user id**. Pégalo en `TELEGRAM_ALLOWED_USER_IDS` y reinicia.

Ya puedes mandar notas de voz.

Comprobaciones útiles sin pasar por el chat:

```bash
npm run smoke            # texto -> TTS -> OGG -> whisper -> texto (valida el audio real)
npm run check:telegram   # valida el token y avisa si hay un webhook que estorbe
npm run check:agent      # ejecuta una orden real por el adaptador del agente (AGENT)
```

## Uso

- **Nota de voz** o **mensaje de texto** → orden para el agente. El bot confirma lo que entendió
  antes de ejecutar.
- `/new` — empieza un hilo limpio (olvida la sesión anterior).
- `/status` — carpeta de trabajo, permisos, cola, sesión y comprobaciones pendientes.
- `/procesos` — qué está ejecutando el agente ahora mismo, con un botón para detener cada uno.
- `/voices` — voces TTS instaladas (para elegir `TTS_VOICE`).
- `/help` — ayuda.

Las órdenes de un mismo chat se ejecutan **en cola y en orden**. Chats distintos no se bloquean
entre sí.

### "¿Por qué tarda tanto?" y detener un proceso

Si preguntas por la lentitud (*"¿por qué tarda tanto?"*, *"está tardando mucho"*, *"¿qué está
haciendo?"*), el bot no lanza otra orden: te contesta con lo que hay en marcha y un teclado para
pararlo.

```
🔎 Procesos del agente en marcha (2):

• PID 10544 · Devin · 12m 30s
  "arregla el login del panel"
• PID 8160 · devin (fuera del puente) · 3m
  "devin --print -- ..."

Pulsa uno para detenerlo. Detener una orden corta el trabajo en curso.

[⛔ 10544 · Devin · 12m 30s]
[⛔ 8160 · devin · 3m]
[🔄 Actualizar]
```

- Solo se listan los procesos del **CLI del agente**: la app de Devin Desktop se excluye a propósito
  (se reconoce por ruta), para que nadie la cierre desde el chat.
- Al pulsar un botón se hace `taskkill /T /F` sobre ese árbol de procesos y se refresca la lista.
- El pid se registra en el momento de lanzar la orden (`onSpawn`), así que los procesos del puente
  llevan su orden; los de la terminal del IDE aparecen como *(fuera del puente)* con su línea de
  comandos.
- La misma información está en `data/status.json` (`processes`) para el panel de la bandeja.

Al terminar, el resumen cierra con `🟢 Esperando nuevas ordenes.` o `⏳ Quedan N orden(es) en cola.`
No se envía la salida completa del agente: el texto se resume conservando el principio (contexto) y el
final (la conclusión de lo que hizo), con `…` marcando el tramo omitido.

### Sesiones de Devin: estado y avisos

Devin guarda todas sus sesiones (las del IDE y las del CLI) en una base SQLite local. El puente la
lee cada 5 s y con eso sabe **qué se está trabajando y cuándo termina**:

- En el panel aparecen todas las sesiones recientes con título, estado (`Trabajando` / `En pausa`),
  tiempo desde la última actividad y su id.
- Cuando una sesión lleva ~20 s sin actividad y su último mensaje es del asistente, se considera que
  el turno ha terminado y te llega un aviso:

```
✅ Sesion de Devin terminada
Proyecto: ConnectAgentToTelegram
Sesion: ConnectAgentToTelegram: conectar agente a Telegram
Sin actividad desde hace 24s

Resumen de lo que hizo:
He publicado el repositorio y creado el aviso de sesiones...
```

El aviso no copia el mensaje entero: conserva el principio y el final, y marca con `…` lo que queda
en medio. La conclusión suele estar al final, así que se ve en qué terminó el turno aunque el mensaje
sea largo. Cuando hay tramo omitido, la cabecera lo indica: `(inicio y final del mensaje)`.

Las órdenes que lanza el propio bot se excluyen: ya reciben su resumen normal, sin duplicados.
La primera lectura solo toma línea base, así que al arrancar no te avisa de lo que ya estaba
terminado. Si la base no se puede leer, el panel y los avisos simplemente no muestran sesiones.

### Enrutado: continuar la sesión del IDE

Con `DEVIN_ROUTE=auto` (por defecto), antes de ejecutar una orden el puente busca en la base si el
proyecto (`DEVIN_WORKDIR`) tiene una sesión reciente del IDE. Si la encuentra **y no está trabajando**,
la orden se ejecuta continuando esa conversación, y el resumen lo indica:

```
✅ Listo en 2m 14s
🔗 Continuando la sesion del IDE: Pasar contenido a la web
```

Si esa sesión está ocupada, el puente no la invade: abre una nueva y lo advierte en el resumen.

> **Límite real:** Devin Desktop no expone ninguna vía para inyectar una orden en una ventana abierta
> (`devin <ruta>` solo abre la app). Lo que se consigue es compartir el **historial y el id** de la
> sesión: el turno se ejecuta en el proceso CLI y queda en esa conversación, pero no se ve escribirse
> en la ventana. Si prefieres no mezclar contextos, pon `DEVIN_ROUTE=chat`.

### Enrutado al escritorio: escribir en la ventana del IDE

Con `DEVIN_ROUTE=desktop` el puente **sí escribe en la ventana**: usa UI Automation de Windows para
localizar la ventana cuyo título empieza por el nombre del proyecto (`<proyecto> - Devin`) y el control
`Prompt` de su compositor, escribe la orden y la envía.

Cómo se hace, y por qué así:

1. Se busca la ventana **por proyecto**, no por posición ni por foco: `Silver Utilizar Silver CD 2 ISO - Devin`.
2. Se localiza el control `Edit` llamado `Prompt` en el árbol de accesibilidad de esa ventana.
3. **Si el compositor tiene texto sin enviar, no se toca**: se aborta y la orden cae al CLI. Así no
   se pisa un borrador que estés escribiendo.
4. **Si la sesión del IDE está trabajando, tampoco se escribe**: en ese estado el botón del compositor
   es `Detener Devin` y Enter no envía, **encola** el mensaje dentro del IDE (y el compositor se vacía,
   que parece que borra la orden). Se detecta antes de pegar y la orden cae al CLI.
5. Se activa la ventana de verdad (Windows no deja pasar a primer plano a un proceso en segundo plano:
   hace falta un ALT previo) y se enfoca el compositor. Se **pega con Ctrl+V** (evento real), no
   escribiendo por `ValuePattern`: el compositor es un editor Slate y `SetValue` lo deja
   desincronizado, con lo que luego no se puede teclear.
6. Se verifica que el texto está en el compositor y que el foco sigue ahí; solo entonces se **pulsa el
   botón `Enviar`** (por `InvokePattern`), no Enter a ciegas. Se da por enviado cuando el compositor se
   vacía. Tras enviar, se devuelve el foco al compositor, listo para escribir.
7. Si la ventana o el control no aparecen, la orden cae al CLI y el resumen lo advierte. En ningún caso
   se borra el texto del compositor: si algo falla, la orden se queda escrita.

El trabajo ocurre en la ventana, así que el resumen no es inmediato: lo entrega el monitor de sesiones
cuando ese turno termina.

Requisitos y efectos:

- La ventana tiene que estar **abierta** y su título empezar por el nombre de la carpeta de
  `DEVIN_WORKDIR`… salvo que **nombres el proyecto en la orden** (ver abajo).
- El puente **roba el foco** un instante para escribir. Si estás tecleando en ese momento, molesta.
- Si el IDE cambia su árbol de accesibilidad (o el control deja de llamarse `Prompt`), el enrutado
  fallará y caerá al CLI: no rompe nada, pero pierde la función.
- No se toca el portapapeles.

#### Elegir proyecto desde la nota de voz

Si tienes varias ventanas abiertas, di el proyecto en la orden y el puente elige esa ventana:

| Dices | Va a |
|---|---|
| "en Silver, continúa con lo pendiente" | `Silver Utilizar Silver CD 2 ISO - Devin` |
| "sigue con jellyfin" | `Jellyfin.Plugin.Torrent - Devin` |
| "revisa el README del proyecto" | la ventana de `DEVIN_WORKDIR` (sin mención explícita) |

El emparejado ignora mayúsculas, acentos y palabras comunes (`de`, `el`, `proyecto`…) y exige una
palabra distintiva de 4+ caracteres, así que "la web" o "el proyecto" no eligen nada por error.

Si nombras un proyecto **que existe pero cuya ventana está cerrada**, el puente **no** cae en la
ventana por defecto: te avisa y ejecuta la orden en el CLI, para no trabajar en el proyecto equivocado.

## Bandeja del sistema (Windows)

```powershell
npm run tray:install   # alta en la carpeta Inicio: arranca con Windows
npm run tray:start     # lanza la bandeja ahora, sin ventana de consola
```

Icono **verde** en ejecución, **rojo** detenido. Al pasar el ratón muestra qué está haciendo el
agente y cuánto lleva. **Doble clic** abre el panel de actividad:

- **Tareas en curso**: cada orden con su estado (`Trabajando`, `En cola`, `Respondiendo`), tiempo y
  sesión. Las que no lanzó el bot aparecen como `Otra sesion - Trabajando`.
- **Tareas recientes**: últimas 8 con duración, sesión y el error si falló.
- **Sesiones del agente (IDE y CLI)**: todas las sesiones recientes con su título, estado y tiempo desde
  la última actividad.
- **Procesos del agente en marcha**: pid, agente, tiempo y si lo lanzó el puente o ya estaba. Selecciona
  una fila y pulsa **Detener proceso** para cortarlo (pide confirmación).
- Casilla **Iniciar con Windows** para activar o quitar el arranque automático sin salir del panel.
- Botones para actualizar, reiniciar o detener el puente, detener un proceso y abrir el log.

Otros comandos:

```powershell
npm run tray:dashboard # bandeja con el panel abierto
npm run tray:lint      # valida la sintaxis de tray.ps1 (un error aquí falla en silencio)
npm run tray:test      # self-test: arranca, comprueba PID, detiene
npm run tray:uninstall # quita el arranque automático
```

El estado en vivo vive en `data/status.json`: lo escribe el puente en cada fase
(`transcribing` → `working` → `replying` → `idle`) con la lista de tareas; la bandeja lo lee cada 2 s.
El historial es en memoria: al reiniciar el puente empieza vacío.

## Configuración

Todo se ajusta en `.env` (ver `.env.example`). Lo importante:

| Variable | Por defecto | Para qué |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — (obligatorio) | Token de @BotFather |
| `TELEGRAM_ALLOWED_USER_IDS` | vacío | Allowlist. Vacío = el bot solo te dice tu user id, no ejecuta nada |
| `AGENT` | `devin` | `devin`, `opencode`, `codex`, `claude` u `openai` |
| `AGENT_WORKDIR` | raíz del proyecto | Carpeta donde trabaja el agente |
| `AGENT_ROUTE` | `auto` | `auto`: reanuda la sesión del agente; `desktop`: escribe en su UI; `chat`: sesión propia por chat |
| `AGENT_CONTINUITY` | `auto` | `auto` (reanuda), `new` (sin memoria), `continue` |
| `AGENT_TIMEOUT_MS` | 20 min | Corte de seguridad por orden |
| `IDE_WINDOW_SUFFIX` | ` - Devin` | Sufijo del título de las ventanas del IDE |
| `WHISPER_LANG` | `es` | Idioma de transcripción |
| `WHISPER_THREADS` | núcleos de la máquina | Hilos de CPU para whisper |
| `TTS_ENABLED` / `TTS_VOICE` | `true` / voz del sistema | Nota de voz de respuesta |
| `TTS_MAX_CHARS` | 1200 | Recorta el audio de respuestas muy largas |
| `MOCK_MODE` | `false` | Transcripción y respuestas simuladas |

Ajustes de cada agente (solo se leen los del `AGENT` elegido):

| Agente | Variables |
|---|---|
| Devin | `DEVIN_BIN`, `DEVIN_MODEL`, `DEVIN_PERMISSION_MODE`, `DEVIN_EXTRA_ARGS`, `DEVIN_SESSIONS_DB` |
| OpenCode | `OPENCODE_BIN`, `OPENCODE_MODEL`, `OPENCODE_AGENT`, `OPENCODE_SKIP_PERMISSIONS`, `OPENCODE_EXTRA_ARGS`, `OPENCODE_SESSIONS_DB`, `OPENCODE_TERMINAL_PATTERN` |
| Codex | `CODEX_BIN`, `CODEX_MODEL`, `CODEX_FULL_AUTO`, `CODEX_SKIP_GIT_CHECK`, `CODEX_EXTRA_ARGS`, `CODEX_SESSIONS_DIR`, `CODEX_TERMINAL_PATTERN` |
| Claude Code | `CLAUDE_BIN`, `CLAUDE_MODEL`, `CLAUDE_PERMISSION_MODE`, `CLAUDE_EXTRA_ARGS`, `CLAUDE_PROJECTS_DIR`, `CLAUDE_TERMINAL_PATTERN` |
| OpenAI | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_MAX_TOKENS`, `OPENAI_TEMPERATURE`, `OPENAI_SYSTEM_PROMPT` |

Los nombres genéricos mandan sobre los históricos: si existen `AGENT_WORKDIR`, `AGENT_ROUTE`,
`AGENT_CONTINUITY` o `AGENT_TIMEOUT_MS`, se usan en lugar de `DEVIN_WORKDIR`, `DEVIN_ROUTE`,
`DEVIN_CONTINUITY` y `DEVIN_TIMEOUT_MS`. Un `.env` antiguo sigue funcionando sin tocar nada.

### Sobre los modos sin confirmaciones

En modo no interactivo no hay nadie para aprobar permisos, así que la orden debe venir
pre-aprobada. Cada agente tiene su equivalente, y todos ejecutan **cualquier** comando sin preguntar:

| Agente | Ajuste por defecto |
|---|---|
| Devin | `DEVIN_PERMISSION_MODE=dangerous` (alias `yolo`/`bypass`) |
| OpenCode | `OPENCODE_SKIP_PERMISSIONS=true` (`--dangerously-skip-permissions`) |
| Codex | `CODEX_FULL_AUTO=true` (`--full-auto`) |
| Claude Code | `CLAUDE_PERMISSION_MODE=bypassPermissions` |

Mitigaciones incluidas:

- allowlist de Telegram: si está vacía, el bot no ejecuta nada y solo devuelve el user id;
- `AGENT_WORKDIR` acota la carpeta de trabajo (el agente puede salir con rutas absolutas: usa una
  carpeta de confianza);
- instancia única para no duplicar sesiones.

Si prefieres algo más conservador, baja el permiso de tu agente (`accept-edits`, `acceptEdits`,
`--full-auto=false`...). A cambio, algunas órdenes fallarán porque nadie aprueba el comando.

## Estructura

```
src/
  index.ts              arranque y cableado de dependencias
  config.ts             lectura y validación del .env (zod), un bloque por agente
  readiness.ts          comprobación del agente, whisper, ffmpeg y TTS
  agents/
    types.ts            puertos: AgentCli, AgentSessions, AgentDesktop
    registry.ts         createAgent(): elige el adaptador según AGENT
    projectMatch.ts     empareja la orden con un proyecto abierto
    devin/              CLI, ventana de Devin Desktop y sessions.db
    opencode/           opencode run y opencode.db
    codex/              codex exec y rollouts .jsonl
    claude/             claude -p y transcripciones .jsonl
    openai/             API /chat/completions (sin CLI ni IDE)
    terminal/           escritura en la terminal integrada del IDE
  core/
    bridge.ts           flujo audio -> texto -> agente -> resumen (sin saber de Telegram)
    sessionMonitor.ts   estado de las sesiones y avisos de turno terminado
    sessionStore.ts     hilo de conversación por chat (JSON atómico)
    taskQueue.ts        cola FIFO por chat
    taskRegistry.ts     historial de tareas para el panel
    statusPublisher.ts  estado en vivo (data/status.json)
    singleInstance.ts   candado por PID (data/bridge.lock)
  audio/
    ffmpeg.ts           conversiones (WAV 16 kHz y OGG/Opus)
    whisper.ts          transcripción local con whisper.cpp
    tts.ts              síntesis con las voces del sistema
  mocks/                dobles para demo y MOCK_MODE
  telegram/bot.ts       adaptador de Telegram (allowlist, descarga de voz, envío)
scripts/                setup de whisper, TTS, demo, checks, bandeja y envío a la UI
tests/                  pruebas unitarias (jest + ts-jest)
```

## Desarrollo

```bash
npm run dev         # recarga al guardar
npm run typecheck   # tsc --noEmit
npm test            # 174 pruebas
npm run demo        # pipeline completo con mocks
npm run smoke       # pipeline de audio real (requiere whisper + ffmpeg)
```

## Problemas frecuentes

| Síntoma | Causa / solución |
|---|---|
| `Devin CLI no tiene sesion iniciada` (pero `devin auth status` dice que sí) | Hay `ACP_BACKEND` en el entorno del proceso. El puente lo elimina solo; revisa `src/agents/devin/env.ts` |
| `La carpeta de trabajo no esta marcada como confiable` | Ejecuta `devin` una vez en esa carpeta y acepta el aviso, o pon `respect_workspace_trust: false` en `.devin/config.local.json` |
| `Falta whisper.cpp` / `Falta el modelo` | `npm run setup:whisper` |
| `No pude transcribir el audio` | `npm run smoke`; revisa `WHISPER_THREADS` y que el audio tenga voz |
| `No autorizado. Tu user id es ...` | Añade ese id a `TELEGRAM_ALLOWED_USER_IDS` y reinicia |
| Respuestas sin audio | `TTS_ENABLED=true`, `/voices` para ver voces, revisa el log |
| El icono de bandeja no aparece | Windows 11 lo esconde en el desplegable: arrástralo a la barra |
| La bandeja no arranca | `npm run tray:lint` (falla en silencio al lanzarse oculta) |

Los logs están en `data/logs/bridge.log` y `data/logs/tray.log`.

## Limitaciones

- **Continuidad por chat**: cada chat guarda su `session id` (leído del export del CLI) y reanuda con
  `--resume`. Solo si el CLI no expone el id se cae a `--continue`, que comparte hilo por carpeta.
- **Sin progreso en vivo durante la orden**: se ve `🤖 Trabajando...` y el resumen al terminar; el
  detalle puntual está en la bandeja y en `/status`.
- **La transcripción es la parte lenta en CPU**: con el modelo `small` ronda 0,7× tiempo real.
  Un modelo menor (`base`) la acelera a costa de precisión. Cada orden registra el desglose
  (`transcribeMs`, `devinMs`, `ttsMs`) en el log.
- **WhatsApp no implementado**: el núcleo (`src/core/bridge.ts`) recibe un `Notifier`, no conoce
  Telegram; añadir otro canal es escribir un adaptador.
- **El estado de una sesión es una heurística**: se considera "trabajando" si hubo actividad en los
  últimos 60 s y "terminada" tras ~20 s sin actividad con un mensaje final del asistente. Una sesión
  abierta pero ociosa puede aparecer como "En pausa" sin haber terminado nada.
- **El resumen se lee del almacén de sesiones del agente** (`node:sqlite` para Devin y OpenCode;
  `.jsonl` para Codex y Claude Code; nada para OpenAI). Si el agente cambia su esquema en una versión
  futura, el panel y los avisos dejan de mostrar sesiones: el resto del puente sigue funcionando.
- **La escritura en la terminal integrada no se puede verificar**: xterm no expone su contenido por UI
  Automation, así que solo se comprueba el foco y que el terminal coincida con el patrón esperado.
  Es una ruta opt-in; para el día a día, `AGENT_ROUTE=auto`.
- **`openai` no toca el repositorio**: es una conversación por API, sin herramientas ni sesiones en
  disco, y su historial se pierde al reiniciar el puente.
- **Un agente por ejecución**: `AGENT` se fija al arrancar. Cambiarlo implica reiniciar el puente
  (o la bandeja), porque cada adaptador cablea su propio CLI, base de sesiones y UI.
- **TTS y bandeja son de Windows**: en Linux/macOS el bot funciona, pero sin voz de vuelta ni icono.

## Licencia

MIT.
