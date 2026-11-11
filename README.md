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
- **Transcripción local** con whisper.cpp (sin APIs de terceros).
- **Respuesta en audio** con las voces de Windows (System.Speech) y conversión a OGG/Opus.
- **Hilo de conversación por chat**: cada chat mantiene su sesión del agente (`--resume`).
- **Cola por chat**: si mandas varias órdenes seguidas, se ejecutan en orden y te avisa de la posición.
- **Bandeja del sistema**: icono con estado, panel de actividad (doble clic) y control de
  iniciar / detener / reiniciar. Arranque automático con Windows.
- **Instancia única**: dos procesos con el mismo token provocarían `409 Conflict` en Telegram.
- **Modo demo con mocks** para probarlo todo sin cuenta de agente ni credenciales.

## Requisitos

| Pieza | Necesario | Nota |
|---|---|---|
| Node.js >= 20.11 | Sí | Probado con Node 22 |
| ffmpeg en el PATH | Sí | Necesita `libopus` (las builds habituales lo traen) |
| Devin CLI + sesión iniciada | Sí (salvo modo demo) | Ver más abajo |
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
irm https://static.devin.ai/cli/setup.ps1 | iex   # Windows
devin auth login
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
npm run check:devin      # ejecuta una orden real por el mismo runner que usa el bot
```

## Uso

- **Nota de voz** o **mensaje de texto** → orden para el agente. El bot confirma lo que entendió
  antes de ejecutar.
- `/new` — empieza un hilo limpio (olvida la sesión anterior).
- `/status` — carpeta de trabajo, permisos, cola, sesión y comprobaciones pendientes.
- `/voices` — voces TTS instaladas (para elegir `TTS_VOICE`).
- `/help` — ayuda.

Las órdenes de un mismo chat se ejecutan **en cola y en orden**. Chats distintos no se bloquean
entre sí.

Al terminar, el resumen cierra con `🟢 Esperando nuevas ordenes.` o `⏳ Quedan N orden(es) en cola.`

## Bandeja del sistema (Windows)

```powershell
npm run tray:install   # alta en la carpeta Inicio: arranca con Windows
npm run tray:start     # lanza la bandeja ahora, sin ventana de consola
```

Icono **verde** en ejecución, **rojo** detenido. Al pasar el ratón muestra qué está haciendo el
agente y cuánto lleva. **Doble clic** abre el panel de actividad:

- **En curso**: cada orden con su estado (`Trabajando`, `En cola`, `Respondiendo`), tiempo y sesión.
- **Recientes**: últimas 8 con duración, sesión y el error si falló.
- Botones para actualizar, reiniciar o detener el puente y abrir el log.

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
| `DEVIN_WORKDIR` | raíz del proyecto | Carpeta donde trabaja el agente |
| `DEVIN_PERMISSION_MODE` | `dangerous` | `normal`, `accept-edits`, `smart`, `dangerous` |
| `DEVIN_CONTINUITY` | `auto` | `auto` (reanuda), `new` (sin memoria), `continue` |
| `DEVIN_TIMEOUT_MS` | 20 min | Corte de seguridad por orden |
| `DEVIN_MODEL` | el del CLI | Alias o nombre de modelo |
| `WHISPER_LANG` | `es` | Idioma de transcripción |
| `WHISPER_THREADS` | núcleos de la máquina | Hilos de CPU para whisper |
| `TTS_ENABLED` / `TTS_VOICE` | `true` / voz del sistema | Nota de voz de respuesta |
| `TTS_MAX_CHARS` | 1200 | Recorta el audio de respuestas muy largas |
| `MOCK_MODE` | `false` | Transcripción y respuestas simuladas |

### Sobre `DEVIN_PERMISSION_MODE=dangerous`

En modo no interactivo no hay nadie para aprobar permisos, así que la orden debe venir
pre-aprobada. `dangerous` (alias `yolo`/`bypass`) ejecuta **cualquier** comando sin preguntar.
Mitigaciones incluidas:

- allowlist de Telegram: si está vacía, el bot no ejecuta nada y solo devuelve el user id;
- `DEVIN_WORKDIR` acota la carpeta de trabajo (el agente puede salir con rutas absolutas: usa una
  carpeta de confianza);
- instancia única para no duplicar sesiones.

Si prefieres algo más conservador, usa `accept-edits` (edita archivos, no ejecuta shell) o `smart`
(un modelo rápido decide si un comando es seguro). A cambio, algunas órdenes fallarán porque nadie
aprueba el comando.

## Estructura

```
src/
  index.ts              arranque y cableado de dependencias
  config.ts             lectura y validación del .env (zod)
  readiness.ts          comprobación de CLI, whisper, ffmpeg y TTS
  core/
    bridge.ts           flujo audio -> texto -> agente -> resumen (sin saber de Telegram)
    taskQueue.ts        cola FIFO por chat
    taskRegistry.ts     historial de tareas para el panel
    statusPublisher.ts  estado en vivo (data/status.json)
    singleInstance.ts   candado por PID (data/bridge.lock)
  audio/
    ffmpeg.ts           conversiones (WAV 16 kHz y OGG/Opus)
    whisper.ts          transcripción local con whisper.cpp
    tts.ts              síntesis con las voces del sistema
  devin/
    devinRunner.ts      invoca el CLI, preflight de sesión, timeout y session id
    sessionStore.ts     hilo de conversación por chat (JSON atómico)
    env.ts              sanea el entorno antes de lanzar el CLI
  mocks/                dobles para demo y MOCK_MODE
  telegram/bot.ts       adaptador de Telegram (allowlist, descarga de voz, envío)
scripts/                setup de whisper, TTS, demo, checks y bandeja
tests/                  pruebas unitarias (jest + ts-jest)
```

## Desarrollo

```bash
npm run dev         # recarga al guardar
npm run typecheck   # tsc --noEmit
npm test            # 81 pruebas
npm run demo        # pipeline completo con mocks
npm run smoke       # pipeline de audio real (requiere whisper + ffmpeg)
```

## Problemas frecuentes

| Síntoma | Causa / solución |
|---|---|
| `Devin CLI no tiene sesion iniciada` (pero `devin auth status` dice que sí) | Hay `ACP_BACKEND` en el entorno del proceso. El puente lo elimina solo; revisa `src/devin/env.ts` |
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
- **TTS y bandeja son de Windows**: en Linux/macOS el bot funciona, pero sin voz de vuelta ni icono.

## Licencia

MIT.
