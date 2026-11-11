param(
    [string]$ProjectRoot,
    [switch]$Install,
    [switch]$Uninstall,
    [switch]$SelfTest,
    [switch]$NoAutoStart,
    [switch]$ShowDashboard
)

$ErrorActionPreference = 'Stop'

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
$ProjectRoot = (Resolve-Path $ProjectRoot).Path

$dataDir = Join-Path $ProjectRoot 'data'
$logDir = Join-Path $dataDir 'logs'
$lockFile = Join-Path $dataDir 'bridge.lock'
$statusFile = Join-Path $dataDir 'status.json'
$bridgeLog = Join-Path $logDir 'bridge.log'
$trayLog = Join-Path $logDir 'tray.log'
$vbsPath = Join-Path $PSScriptRoot 'tray.vbs'
$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'ConnectAgentToTelegram.lnk'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-TrayLog([string]$Message) {
    $line = '{0} {1}' -f (Get-Date -Format 's'), $Message
    Add-Content -Path $trayLog -Value $line -Encoding UTF8
}

function Resolve-NodePath {
    $candidates = @()
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $candidates += $cmd.Source }
    $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe')

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    throw 'No encuentro node.exe. Instala Node.js o anadelo al PATH.'
}

function Get-BridgePid {
    if (-not (Test-Path $lockFile)) { return $null }
    try {
        $info = Get-Content -Path $lockFile -Raw | ConvertFrom-Json
    } catch {
        return $null
    }
    if (-not $info.pid) { return $null }
    $process = Get-Process -Id $info.pid -ErrorAction SilentlyContinue
    if ($process) { return [int]$info.pid }
    return $null
}

function Start-Bridge {
    if (Get-BridgePid) { return }
    $node = Resolve-NodePath

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $node
    $psi.Arguments = '--import tsx src/index.ts'
    $psi.WorkingDirectory = $ProjectRoot
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    [System.Diagnostics.Process]::Start($psi) | Out-Null

    Write-TrayLog 'Puente arrancado'
}

function Stop-Bridge {
    $targetPid = Get-BridgePid
    if (-not $targetPid) {
        Remove-Item -Path $lockFile -ErrorAction SilentlyContinue
        return
    }

    & taskkill.exe /PID $targetPid /T /F 2>&1 | Out-Null
    for ($i = 0; $i -lt 24; $i++) {
        if (-not (Get-BridgePid)) { break }
        Start-Sleep -Milliseconds 250
    }
    Remove-Item -Path $lockFile -ErrorAction SilentlyContinue
    Write-TrayLog 'Puente detenido'
}

function Get-StatusText {
    $bridgePid = Get-BridgePid
    if ($bridgePid) { return "En ejecucion (PID $bridgePid)" }
    return 'Detenido'
}

function Get-BridgeStatus {
    if (-not (Test-Path $statusFile)) { return $null }
    try {
        return Get-Content -Path $statusFile -Raw | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Limit-Text([string]$Text, [int]$Max) {
    if (-not $Text) { return '' }
    $clean = ($Text -replace '\s+', ' ').Trim()
    if ($clean.Length -le $Max) { return $clean }
    # Los puntos suspensivos cuentan: recortar Max-3 y anadir '...' deja exactamente $Max.
    return $clean.Substring(0, $Max - 3) + '...'
}

# Describe que esta haciendo el puente ahora mismo, para el tooltip y el menu.
function Get-ActivityText {
    $status = Get-BridgeStatus
    if (-not $status) { return 'En espera de ordenes' }

    if ($status.state -eq 'transcribing') {
        return 'Transcribiendo audio'
    }

    $current = $status.current
    if (-not $current) {
        if ($status.queue -gt 0) { return ("{0} orden(es) en cola" -f $status.queue) }
        return 'En espera de ordenes'
    }

    $elapsed = Format-Elapsed $current.startedAt
    $suffix = ''
    if ($elapsed) { $suffix = " ($elapsed)" }

    $prefix = 'Devin trabajando'
    if ($current.source -eq 'external') { $prefix = 'Otra sesion de Devin' }

    switch ($current.state) {
        'replying' { return "Enviando respuesta$suffix" }
        default { return "$prefix$suffix`: $(Limit-Text $current.prompt 45)" }
    }
}

function Format-Elapsed([double]$FromMs) {
    if (-not $FromMs -or $FromMs -le 0) { return '' }
    $seconds = [int]((([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) - $FromMs) / 1000)
    if ($seconds -lt 60) { return ('{0}s' -f $seconds) }
    return ('{0}m {1}s' -f [math]::Floor($seconds / 60), ($seconds % 60))
}

function Format-Duration([double]$Ms) {
    if (-not $Ms) { return '-' }
    $seconds = [int]($Ms / 1000)
    if ($seconds -lt 60) { return ('{0}s' -f $seconds) }
    return ('{0}m {1}s' -f [math]::Floor($seconds / 60), ($seconds % 60))
}

function Get-TaskStateLabel([string]$State) {
    switch ($State) {
        'queued' { return 'En cola' }
        'working' { return 'Trabajando' }
        'replying' { return 'Respondiendo' }
        'done' { return 'Completada' }
        'error' { return 'Error' }
        default { return $State }
    }
}

function Get-TaskStateColor([string]$State) {
    switch ($State) {
        'done' { return [System.Drawing.Color]::FromArgb(39, 174, 96) }
        'error' { return [System.Drawing.Color]::FromArgb(192, 57, 43) }
        'working' { return [System.Drawing.Color]::FromArgb(211, 84, 0) }
        'replying' { return [System.Drawing.Color]::FromArgb(41, 128, 185) }
        default { return [System.Drawing.Color]::FromArgb(127, 140, 141) }
    }
}

# Procesos de Devin vivos en la maquina. Se descartan los subprocesos de Chromium del IDE
# (--type=renderer, --type=gpu-process, --require=...), que inundarian la lista sin aportar nada.
function Get-DevinProcesses {
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='devin.exe'" -ErrorAction Stop
    } catch {
        return @()
    }

    $result = @()
    foreach ($proc in $procs) {
        $path = $proc.ExecutablePath
        $cmd = $proc.CommandLine
        if (-not $path) { continue }

        $kind = $null
        if ($path -like '*\devin\cli\bin\devin.exe') {
            $kind = 'Devin CLI'
        } elseif ($path -like '*\Programs\Devin\Devin.exe') {
            # Solo el proceso principal del IDE: sin argumentos ni subprocesos auxiliares.
            $trimmed = $cmd.Trim()
            $quoted = '"' + $path + '"'
            if ($trimmed -ne $quoted -and $trimmed -ne $path) { continue }
            $kind = 'Devin Desktop'
        } else {
            continue
        }

        $startMs = 0
        if ($proc.CreationDate) {
            $startMs = ([DateTimeOffset]$proc.CreationDate).ToUnixTimeMilliseconds()
        }
        $result += [pscustomobject]@{
            Pid = $proc.ProcessId
            Kind = $kind
            Command = $cmd
            StartMs = $startMs
        }
    }
    return $result
}

function New-DotIcon([System.Drawing.Color]$Color) {
    $bitmap = New-Object System.Drawing.Bitmap 16, 16
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.SolidBrush $Color
    $graphics.FillEllipse($brush, 1, 1, 13, 13)
    $brush.Dispose()
    $graphics.Dispose()
    $handle = $bitmap.GetHicon()
    return [System.Drawing.Icon]::FromHandle($handle)
}

function Install-Autostart {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($startupLnk)
    $shortcut.TargetPath = 'wscript.exe'
    $shortcut.Arguments = '"' + $vbsPath + '"'
    $shortcut.WorkingDirectory = $ProjectRoot
    $shortcut.Description = 'Puente Telegram -> Devin'
    $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
    $shortcut.Save()
    Write-TrayLog 'Autostart instalado'
}

function Uninstall-Autostart {
    if (Test-Path $startupLnk) { Remove-Item $startupLnk -Force }
    Write-TrayLog 'Autostart eliminado'
}

# --- Modos sin interfaz -------------------------------------------------------

if ($Install) {
    Install-Autostart
    Write-Host "Autostart instalado: $startupLnk"
    exit 0
}

if ($Uninstall) {
    Uninstall-Autostart
    Write-Host 'Autostart eliminado.'
    exit 0
}

if ($SelfTest) {
    $longText = 'ConnectAgentToTelegram: Devin trabajando (1m 45s): revisa el modulo de pedidos y arregla la validacion del telefono'
    $short = Limit-Text $longText 60
    if ($short.Length -gt 60) {
        Write-Host ("SelfTest FALLO: el tooltip mide {0} caracteres (maximo 60)" -f $short.Length)
        exit 1
    }
    Write-Host ("SelfTest: tooltip recortado a {0} caracteres" -f $short.Length)

    Write-Host 'SelfTest: arrancando puente...'
    Start-Bridge
    Start-Sleep -Seconds 8
    $first = Get-BridgePid
    Write-Host ("SelfTest: PID tras arrancar = {0}" -f ($(if ($first) { $first } else { 'ninguno' })))

    Write-Host 'SelfTest: deteniendo...'
    Stop-Bridge
    Start-Sleep -Seconds 2
    $after = Get-BridgePid

    if (-not $first) { Write-Host 'SelfTest FALLO: no arranco'; exit 1 }
    if ($after) { Write-Host 'SelfTest FALLO: sigue vivo'; exit 1 }

    Write-Host 'SelfTest OK'
    exit 0
}

# --- Bandeja -----------------------------------------------------------------

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$mutex = New-Object System.Threading.Mutex($false, 'ConnectAgentToTelegramTray')
if (-not $mutex.WaitOne(0)) {
    Write-TrayLog 'Ya hay una bandeja en ejecucion; se cierra esta instancia'
    exit 0
}

$script:iconRunning = New-DotIcon ([System.Drawing.Color]::FromArgb(46, 204, 113))
$script:iconStopped = New-DotIcon ([System.Drawing.Color]::FromArgb(231, 76, 60))
$script:iconStarting = New-DotIcon ([System.Drawing.Color]::FromArgb(241, 196, 15))

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $script:iconStopped
$notify.Text = 'ConnectAgentToTelegram: detenido'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem
$statusItem.Text = 'Estado: detenido'
$statusItem.Enabled = $false
[void]$menu.Items.Add($statusItem)

$activityItem = New-Object System.Windows.Forms.ToolStripMenuItem
$activityItem.Text = 'Ahora: en espera'
$activityItem.Enabled = $false
[void]$menu.Items.Add($activityItem)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$startItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Iniciar puente'
$stopItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Detener puente'
$restartItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Reiniciar puente'

[void]$menu.Items.Add($startItem)
[void]$menu.Items.Add($stopItem)
[void]$menu.Items.Add($restartItem)

$dashboardItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Ver actividad (doble clic)'
[void]$menu.Items.Add($dashboardItem)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$logItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Abrir log'
$folderItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Abrir carpeta del proyecto'
[void]$menu.Items.Add($logItem)
[void]$menu.Items.Add($folderItem)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$autostartItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Arrancar con Windows'
$autostartItem.CheckOnClick = $false
[void]$menu.Items.Add($autostartItem)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Salir'
[void]$menu.Items.Add($exitItem)

$notify.ContextMenuStrip = $menu

$script:lastState = ''

function Update-Ui {
    $bridgePid = Get-BridgePid
    $running = [bool]$bridgePid

    if ($running) {
        $state = "En ejecucion (PID $bridgePid)"
        $activity = Get-ActivityText
        $notify.Icon = $script:iconRunning
        # NotifyIcon.Text admite 63 caracteres como maximo y lanza excepcion si se pasa.
        $notify.Text = Limit-Text "ConnectAgentToTelegram: $activity" 60
    } else {
        $state = 'Detenido'
        $activity = 'Sin actividad'
        $notify.Icon = $script:iconStopped
        $notify.Text = 'ConnectAgentToTelegram: detenido'
    }

    $statusItem.Text = "Estado: $state"
    $activityItem.Text = "Ahora: $activity"
    $startItem.Enabled = -not $running
    $stopItem.Enabled = $running
    $restartItem.Enabled = $running
    $autostartItem.Checked = Test-Path $startupLnk

    if ($script:lastState -and $script:lastState -ne $running) {
        if ($running) {
            $notify.ShowBalloonTip(3000, 'Puente iniciado', 'El puente Telegram -> Devin esta escuchando.', 'Info')
        } else {
            $notify.ShowBalloonTip(5000, 'Puente detenido', 'Revisa el log si no lo has parado tu.', 'Warning')
        }
    }
    $script:lastState = $running
}

$startItem.add_Click({
    try {
        $notify.Icon = $script:iconStarting
        Start-Bridge
        Start-Sleep -Milliseconds 1200
        Update-Ui
    } catch {
        Write-TrayLog ("Error al arrancar: " + $_)
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'ConnectAgentToTelegram') | Out-Null
    }
})

$stopItem.add_Click({
    try { Stop-Bridge; Update-Ui } catch { Write-TrayLog ("Error al detener: " + $_) }
})

$restartItem.add_Click({
    try {
        Stop-Bridge
        Start-Sleep -Milliseconds 500
        Start-Bridge
        Start-Sleep -Milliseconds 1200
        Update-Ui
    } catch { Write-TrayLog ("Error al reiniciar: " + $_) }
})

$dashboardItem.add_Click({ Show-Dashboard })

$logItem.add_Click({
    if (Test-Path $bridgeLog) { Start-Process notepad.exe $bridgeLog } else { [System.Windows.Forms.MessageBox]::Show('Todavia no hay log.', 'ConnectAgentToTelegram') | Out-Null }
})

$folderItem.add_Click({ Start-Process explorer.exe $ProjectRoot })

$autostartItem.add_Click({
    try {
        if (Test-Path $startupLnk) { Uninstall-Autostart } else { Install-Autostart }
        Update-Ui
    } catch { Write-TrayLog ("Error con autostart: " + $_) }
})

$exitItem.add_Click({
    Stop-Bridge
    $notify.Visible = $false
    $notify.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

$script:dash = $null

function Show-Dashboard {
    if ($script:dashForm -and -not $script:dashForm.IsDisposed) {
        $script:dashForm.Activate()
        return
    }

    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'ConnectAgentToTelegram - actividad de Devin'
    $form.ClientSize = New-Object System.Drawing.Size 780, 430
    $form.StartPosition = 'CenterScreen'
    $form.Font = New-Object System.Drawing.Font 'Segoe UI', 9
    $form.MinimumSize = New-Object System.Drawing.Size 640, 320

    $header = New-Object System.Windows.Forms.Label
    $header.Location = New-Object System.Drawing.Point 10, 8
    $header.Size = New-Object System.Drawing.Size 760, 40
    $header.Anchor = 'Top,Left,Right'
    $form.Controls.Add($header)

    $list = New-Object System.Windows.Forms.ListView
    $list.Location = New-Object System.Drawing.Point 10, 52
    $list.Size = New-Object System.Drawing.Size 760, 320
    $list.Anchor = 'Top,Bottom,Left,Right'
    $list.View = 'Details'
    $list.FullRowSelect = $true
    $list.GridLines = $true
    $list.ShowGroups = $true
    [void]$list.Columns.Add('Orden', 420)
    [void]$list.Columns.Add('Estado', 110)
    [void]$list.Columns.Add('Tiempo', 90)
    [void]$list.Columns.Add('Sesion', 120)
    $groupActive = New-Object System.Windows.Forms.ListViewGroup 'Tareas en curso'
    $groupRecent = New-Object System.Windows.Forms.ListViewGroup 'Tareas recientes'
    $groupProcs = New-Object System.Windows.Forms.ListViewGroup 'Procesos de Devin en el sistema (CLI y escritorio)'
    [void]$list.Groups.Add($groupActive)
    [void]$list.Groups.Add($groupRecent)
    [void]$list.Groups.Add($groupProcs)
    $form.Controls.Add($list)

    $buttons = New-Object System.Windows.Forms.FlowLayoutPanel
    $buttons.Location = New-Object System.Drawing.Point 10, 380
    $buttons.Size = New-Object System.Drawing.Size 760, 40
    $buttons.Anchor = 'Bottom,Left,Right'
    $form.Controls.Add($buttons)

    $refreshButton = New-Object System.Windows.Forms.Button
    $refreshButton.Text = 'Actualizar'
    $refreshButton.Width = 110
    $refreshButton.Height = 30
    [void]$buttons.Controls.Add($refreshButton)

    $restartButton = New-Object System.Windows.Forms.Button
    $restartButton.Text = 'Reiniciar puente'
    $restartButton.Width = 130
    $restartButton.Height = 30
    [void]$buttons.Controls.Add($restartButton)

    $stopButton = New-Object System.Windows.Forms.Button
    $stopButton.Text = 'Detener puente'
    $stopButton.Width = 125
    $stopButton.Height = 30
    [void]$buttons.Controls.Add($stopButton)

    $logButton = New-Object System.Windows.Forms.Button
    $logButton.Text = 'Abrir log'
    $logButton.Width = 100
    $logButton.Height = 30
    [void]$buttons.Controls.Add($logButton)

    $closeButton = New-Object System.Windows.Forms.Button
    $closeButton.Text = 'Cerrar'
    $closeButton.Width = 90
    $closeButton.Height = 30
    [void]$buttons.Controls.Add($closeButton)

    $autostartCheck = New-Object System.Windows.Forms.CheckBox
    $autostartCheck.Text = 'Iniciar con Windows'
    $autostartCheck.Width = 160
    $autostartCheck.Height = 30
    $autostartCheck.Padding = New-Object System.Windows.Forms.Padding 12, 6, 0, 0
    [void]$buttons.Controls.Add($autostartCheck)

    # Los controles van a ambito de script: los scriptblocks de eventos y del timer
    # no capturan variables locales de esta funcion (PowerShell no cierra sobre el scope).
    $script:dashForm = $form
    $script:dashHeader = $header
    $script:dashList = $list
    $script:dashGroupActive = $groupActive
    $script:dashGroupRecent = $groupRecent
    $script:dashGroupProcs = $groupProcs
    $script:dashStopButton = $stopButton
    $script:dashRestartButton = $restartButton
    $script:dashAutostart = $autostartCheck

    $script:dashRefresh = {
        try {
            $status = Get-BridgeStatus
            $bridgePid = Get-BridgePid
            $listView = $script:dashList
            $headerLabel = $script:dashHeader

            if ($bridgePid) {
                $headerLabel.Text = "Puente en ejecucion (PID $bridgePid). Actualizado: $(Get-Date -Format 'HH:mm:ss')"
            } else {
                $headerLabel.Text = "Puente detenido. Actualizado: $(Get-Date -Format 'HH:mm:ss')"
            }

            $listView.BeginUpdate()
            $listView.Items.Clear()

            $activeTasks = @()
            $recentTasks = @()
            if ($status) {
                if ($status.active) { $activeTasks = @($status.active) }
                if ($status.recent) { $recentTasks = @($status.recent) }
            }

            if ($activeTasks.Count -eq 0) {
                $empty = New-Object System.Windows.Forms.ListViewItem 'Sin ordenes en curso'
                $empty.Group = $script:dashGroupActive
                $empty.ForeColor = [System.Drawing.Color]::Gray
                [void]$listView.Items.Add($empty)
            }

            foreach ($task in $activeTasks) {
                $item = New-Object System.Windows.Forms.ListViewItem((Limit-Text $task.prompt 160))
                $stateLabel = Get-TaskStateLabel $task.state
                if ($task.source -eq 'external') { $stateLabel = "Otra sesion - $stateLabel" }
                [void]$item.SubItems.Add($stateLabel)
                $elapsed = Format-Elapsed $task.startedAt
                if (-not $elapsed) { $elapsed = '-' }
                [void]$item.SubItems.Add($elapsed)
                if ($task.sessionId) { [void]$item.SubItems.Add($task.sessionId) } else { [void]$item.SubItems.Add('-') }
                $item.Group = $script:dashGroupActive
                $item.ForeColor = Get-TaskStateColor $task.state
                [void]$listView.Items.Add($item)
            }

            if ($recentTasks.Count -eq 0) {
                $emptyRecent = New-Object System.Windows.Forms.ListViewItem 'Todavia no hay ordenes terminadas'
                $emptyRecent.Group = $script:dashGroupRecent
                $emptyRecent.ForeColor = [System.Drawing.Color]::Gray
                [void]$listView.Items.Add($emptyRecent)
            }

            foreach ($task in $recentTasks) {
                $label = Limit-Text $task.prompt 160
                if ($task.error) { $label = $label + ' -> ' + (Limit-Text $task.error 60) }
                $item = New-Object System.Windows.Forms.ListViewItem($label)
                $stateLabel = Get-TaskStateLabel $task.state
                if ($task.source -eq 'external') { $stateLabel = "Otra sesion - $stateLabel" }
                [void]$item.SubItems.Add($stateLabel)
                [void]$item.SubItems.Add((Format-Duration $task.durationMs))
                if ($task.sessionId) { [void]$item.SubItems.Add($task.sessionId) } else { [void]$item.SubItems.Add('-') }
                $item.Group = $script:dashGroupRecent
                $item.ForeColor = Get-TaskStateColor $task.state
                [void]$listView.Items.Add($item)
            }

            $devinProcs = Get-DevinProcesses
            if ($devinProcs.Count -eq 0) {
                $emptyProcs = New-Object System.Windows.Forms.ListViewItem 'No hay procesos de Devin en ejecucion'
                $emptyProcs.Group = $script:dashGroupProcs
                $emptyProcs.ForeColor = [System.Drawing.Color]::Gray
                [void]$listView.Items.Add($emptyProcs)
            }

            foreach ($proc in $devinProcs) {
                $label = $proc.Command
                if (-not $label) { $label = $proc.Kind }
                $item = New-Object System.Windows.Forms.ListViewItem((Limit-Text $label 160))
                [void]$item.SubItems.Add($proc.Kind)
                [void]$item.SubItems.Add((Format-Elapsed $proc.StartMs))
                [void]$item.SubItems.Add("PID $($proc.Pid)")
                $item.Group = $script:dashGroupProcs
                $item.ForeColor = [System.Drawing.Color]::FromArgb(52, 73, 94)
                [void]$listView.Items.Add($item)
            }

            $listView.EndUpdate()

            $script:dashAutostart.Checked = Test-Path $startupLnk

            $running = [bool]$bridgePid
            $script:dashStopButton.Enabled = $running
            $script:dashRestartButton.Enabled = $running
        } catch {
            Write-TrayLog ("Error refrescando el panel: " + $_)
        }
    }

    $dashTimer = New-Object System.Windows.Forms.Timer
    $dashTimer.Interval = 2000
    $dashTimer.add_Tick($script:dashRefresh)
    $dashTimer.Start()
    $script:dashTimer = $dashTimer

    $refreshButton.add_Click($script:dashRefresh)
    $closeButton.add_Click({ $script:dashForm.Close() })
    $autostartCheck.add_Click({
        try {
            if (Test-Path $startupLnk) { Uninstall-Autostart } else { Install-Autostart }
            $script:dashAutostart.Checked = Test-Path $startupLnk
            Update-Ui
        } catch {
            Write-TrayLog ("Error con el inicio automatico: " + $_)
            $script:dashAutostart.Checked = Test-Path $startupLnk
        }
    })
    $logButton.add_Click({
        if (Test-Path $bridgeLog) { Start-Process notepad.exe $bridgeLog }
    })
    $stopButton.add_Click({
        try { Stop-Bridge; & $script:dashRefresh; Update-Ui } catch { Write-TrayLog ("Error al detener: " + $_) }
    })
    $restartButton.add_Click({
        try {
            Stop-Bridge
            Start-Sleep -Milliseconds 500
            Start-Bridge
            Start-Sleep -Milliseconds 1200
            & $script:dashRefresh
            Update-Ui
        } catch { Write-TrayLog ("Error al reiniciar: " + $_) }
    })

    $form.add_FormClosed({
        try {
            $script:dashTimer.Stop()
            $script:dashTimer.Dispose()
        } catch { }
        $script:dashForm = $null
        $script:dashTimer = $null
    })

    & $script:dashRefresh
    $form.Show()
}

$notify.add_DoubleClick({ Show-Dashboard })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
    # Una excepcion aqui abriria un modal de .NET y dejaria la bandeja inutilizable.
    try {
        Update-Ui
    } catch {
        Write-TrayLog ("Error actualizando la interfaz: " + $_)
        try { $notify.Text = 'ConnectAgentToTelegram: error de interfaz' } catch { }
    }
})
$timer.Start()

Update-Ui

if (-not $NoAutoStart) {
    try {
        Start-Bridge
        Start-Sleep -Milliseconds 1200
        Update-Ui
    } catch { Write-TrayLog ("Error en autostart del puente: " + $_) }
}

if ($ShowDashboard) {
    Show-Dashboard
}

[System.Windows.Forms.Application]::Run()
