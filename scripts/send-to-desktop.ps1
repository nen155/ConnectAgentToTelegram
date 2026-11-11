param(
    [string]$Project,
    [string]$PromptFile,
    [switch]$DryRun,
    # Pega y limpia sin enviar. Para probar sin lanzar nada.
    [switch]$NoSubmit,
    # Devuelve en JSON las ventanas de Devin Desktop abiertas y su proyecto.
    [switch]$ListWindows,
    # Sufijo del titulo de la ventana (" - Devin" en Devin Desktop).
    [string]$WindowSuffix = ' - Devin'
)

# Envia una orden al compositor de la ventana de Devin Desktop cuyo titulo empieza por el
# nombre del proyecto.
#
# Se pega con Ctrl+V (evento real) en vez de escribir por ValuePattern: el compositor es un
# editor Slate y SetValue lo deja desincronizado, de modo que despues el usuario no puede
# teclear. Con el pegado, el editor procesa el texto como si lo hubiera escrito una persona
# y queda limpio y usable tras el Enter.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms

# Los scriptblocks que se pasan a EnumWindows no ven las variables locales de la funcion
# que los crea: el sufijo del titulo tiene que vivir en $script:.
$script:windowSuffix = $WindowSuffix

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnum {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder t, int c);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool enable);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@

function Find-ProjectWindow([string]$name, [string]$suffix) {
    $script:found = $null
    $script:matchPrefix = "$name$suffix"
    $callback = [WinEnum+EnumWindowsProc]{
        param($handle, $state)
        if ([WinEnum]::IsWindowVisible($handle)) {
            $buffer = New-Object System.Text.StringBuilder 512
            [void][WinEnum]::GetWindowText($handle, $buffer, 512)
            $title = $buffer.ToString()
            if ($title.StartsWith($script:matchPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { $script:found = $handle }
        }
        return $true
    }
    [void][WinEnum]::EnumWindows($callback, [IntPtr]::Zero)
    return $script:found
}

function Find-PromptControl($root) {
    $condition = New-Object System.Windows.Automation.AndCondition(
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Edit)),
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty, 'Prompt'))
    )
    return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

# El arbol de control no expone el DOM del panel de Devin: los botones del compositor solo
# aparecen en el arbol raw. Se busca en profundidad por tipo y nombre.
function Find-RawButton([IntPtr]$handle, [string]$name) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    if (-not $root) { return $null }
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $stack = New-Object System.Collections.Stack
    $stack.Push($root)
    while ($stack.Count -gt 0) {
        $parent = $stack.Pop()
        $child = $walker.GetFirstChild($parent)
        while ($child) {
            try {
                $info = $child.Current
                if ($info.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $info.Name -eq $name) {
                    return $child
                }
            } catch { }
            $stack.Push($child)
            $child = $walker.GetNextSibling($child)
        }
    }
    return $null
}

# Mientras el agente trabaja, el boton del compositor es "Detener Devin" en lugar de
# "Enviar". En ese estado Enter NO envia: encola el mensaje en el IDE y el compositor se
# vacia, que es justo lo que parece "borrar la orden" y deja un trabajo en cola sin arrancar.
function Test-SessionBusy([IntPtr]$handle) {
    if (Find-RawButton $handle 'Detener Devin') { return $true }
    if (Find-RawButton $handle 'Stop Devin') { return $true }
    return $false
}

function Get-ComposerValue([IntPtr]$handle) {
    try {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
        if (-not $root) { return '' }
        $control = Find-PromptControl $root
        if (-not $control) { return '' }
        $pattern = $control.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        return [string]$pattern.Current.Value
    } catch {
        return ''
    }
}

# El ValuePattern devuelve el placeholder cuando esta vacio. El IDE rota varios consejos
# ("Guia a Devin...", "Consejo: ...", "presiona Ctrl ...", "...poner el mensaje en cola"),
# asi que se reconocen por patron.
function Test-Placeholder([string]$value) {
    $flat = ($value -replace '\s+', ' ').Trim()
    if (-not $flat) { return $true }
    if ($flat -like '*Gu*a a Devin*') { return $true }
    if ($flat -like '*Consejo:*') { return $true }
    if ($flat -like '*presiona*') { return $true }
    if ($flat -like '*para poner el mensaje en cola*') { return $true }
    return $false
}

function Test-FocusOn($element) {
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    return [System.Windows.Automation.Automation]::Compare($focused, $element)
}

# Activa la ventana de verdad. El foco de UI Automation no basta: si la ventana no esta
# en primer plano, el Ctrl+V no llega al compositor (aunque el elemento tenga el foco).
function Set-WindowForeground([IntPtr]$handle) {
    [void][WinEnum]::ShowWindow($handle, 9)
    if ([WinEnum]::GetForegroundWindow() -eq $handle) { return $true }

    # Windows no deja pasar a primer plano a un proceso en segundo plano salvo que haya
    # recibido la ultima entrada. Un ALT real (down/up) desbloquea ese bloqueo; sin esto
    # SetForegroundWindow devuelve true pero la ventana no se activa y el Ctrl+V se pierde.
    [WinEnum]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
    [void][WinEnum]::SetForegroundWindow($handle)
    Start-Sleep -Milliseconds 150
    [WinEnum]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 400
    if ([WinEnum]::GetForegroundWindow() -eq $handle) { return $true }

    # Reserva: compartir el estado de entrada con el hilo que tiene el primer plano.
    $foreground = [WinEnum]::GetForegroundWindow()
    $foregroundPid = 0
    $foregroundThread = [WinEnum]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
    $currentThread = [WinEnum]::GetCurrentThreadId()

    $attached = $false
    if ($foregroundThread -and $foregroundThread -ne $currentThread) {
        $attached = [WinEnum]::AttachThreadInput($currentThread, $foregroundThread, $true)
    }

    [void][WinEnum]::SetForegroundWindow($handle)
    Start-Sleep -Milliseconds 300

    if ($attached) {
        [void][WinEnum]::AttachThreadInput($currentThread, $foregroundThread, $false)
    }

    return ([WinEnum]::GetForegroundWindow() -eq $handle)
}

# El compositor es un editor Slate que se recrea al pegar: comparar por identidad da falsos
# negativos. Se comprueba por tipo y nombre, que sobreviven al re-render.
function Test-FocusIsPrompt {
    try {
        $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
        if (-not $focused) { return $false }
        $current = $focused.Current
        return ($current.ControlType -eq [System.Windows.Automation.ControlType]::Edit) -and ($current.Name -eq 'Prompt')
    } catch {
        return $false
    }
}

function Clear-Composer {
    if (-not (Test-FocusIsPrompt)) { return $false }
    [System.Windows.Forms.SendKeys]::SendWait('^a')
    [System.Windows.Forms.SendKeys]::SendWait('{DELETE}')
    Start-Sleep -Milliseconds 250
    return $true
}

# El ValuePattern devuelve el placeholder cuando esta vacio: hay que distinguirlo de un
# borrador real del usuario, que nunca se debe pisar. El IDE rota varios consejos como
# placeholder ("Guia a Devin...", "Consejo: ...", "presiona Ctrl ..."), asi que se
# reconocen por patron; cualquier otro texto se considera borrador y no se toca.
function Get-ComposerText($valuePattern) {
    try {
        $value = $valuePattern.Current.Value
        if (-not $value) { return '' }
        if ($value -like '*Gu*a a Devin*') { return '' }
        if ($value -like '*presiona*') { return '' }
        if ($value -like '*Consejo:*') { return '' }
        if ($value -like '*para poner el mensaje en cola*') { return '' }
        return $value.Trim()
    } catch {
        return ''
    }
}

function Get-ClipboardTextSafe {
    try {
        $text = Get-Clipboard -Raw -ErrorAction Stop
        if ($null -eq $text) { return '' }
        return [string]$text
    } catch {
        return ''
    }
}

if ($ListWindows) {
    $script:all = @()
    $listCallback = [WinEnum+EnumWindowsProc]{
        param($handle, $state)
        if ([WinEnum]::IsWindowVisible($handle)) {
            $buffer = New-Object System.Text.StringBuilder 512
            [void][WinEnum]::GetWindowText($handle, $buffer, 512)
            $title = $buffer.ToString()
            $marker = $script:windowSuffix
            $index = $title.IndexOf($marker)
            if ($index -gt 0) {
                $script:all += [pscustomobject]@{
                    project = $title.Substring(0, $index)
                    title   = $title
                }
            }
        }
        return $true
    }
    [void][WinEnum]::EnumWindows($listCallback, [IntPtr]::Zero)
    # PowerShell 5.1 no tiene -AsArray: se fuerza el array con @() antes de serializar.
    Write-Output (ConvertTo-Json -InputObject @($script:all) -Compress)
    exit 0
}

if (-not $Project) {
    Write-Output 'ERROR: falta -Project'
    exit 1
}
if (-not $PromptFile) {
    Write-Output 'ERROR: falta -PromptFile'
    exit 1
}

if (-not (Test-Path $PromptFile)) {
    Write-Output 'ERROR: no existe el archivo con la orden'
    exit 1
}
$prompt = [System.IO.File]::ReadAllText($PromptFile, [System.Text.Encoding]::UTF8).Trim()
if (-not $prompt) {
    Write-Output 'ERROR: la orden esta vacia'
    exit 1
}

$handle = Find-ProjectWindow $Project $WindowSuffix
if (-not $handle) {
    Write-Output "SIN_VENTANA: no hay ninguna ventana '$Project$WindowSuffix' abierta"
    exit 2
}

$root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
$promptControl = Find-PromptControl $root
if (-not $promptControl) {
    Write-Output "SIN_INPUT: la ventana de '$Project' no expone el compositor"
    exit 3
}

if ($DryRun) {
    $rect = $promptControl.Current.BoundingRectangle
    Write-Output ("OK_DRY: ventana=$handle input=$([int]$rect.Width)x$([int]$rect.Height)")
    exit 0
}

$clipboardBackup = Get-ClipboardTextSafe

try {
    # Nunca se pisa un borrador del usuario.
    $initialPattern = $promptControl.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $draft = Get-ComposerText $initialPattern
    if ($draft) {
        Write-Output 'COMPOSITOR_OCUPADO: la ventana tiene texto sin enviar; no se toca'
        exit 9
    }

    # Con la sesion trabajando no se escribe nada: Enter encolaria la orden dentro del IDE.
    if (Test-SessionBusy $handle) {
        Write-Output 'SESION_OCUPADA: la sesion del IDE esta trabajando; no se escribe nada'
        exit 10
    }

    if (-not (Set-WindowForeground $handle)) {
        Write-Output 'ERROR: no pude activar la ventana del IDE; no se envia'
        exit 5
    }

    $promptControl.SetFocus()
    Start-Sleep -Milliseconds 600
    if (-not (Test-FocusIsPrompt)) {
        Write-Output 'ERROR: no consegui el foco en el compositor; no se envia'
        exit 5
    }

    Set-Clipboard -Value $prompt
    Start-Sleep -Milliseconds 120
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 700

    if (-not (Test-FocusIsPrompt)) {
        # Sin borrar: el texto puede estar escrito y se pierde si lo limpiamos.
        Write-Output 'ERROR: el foco se movio durante el pegado; no se envia (no se borra nada)'
        exit 6
    }

    # Verificacion LAXA a proposito: solo se comprueba que el compositor tiene texto.
    # Exigir la coincidencia exacta daba falsos negativos (el editor recrea el nodo al
    # pegar) y acababa BORRANDO la orden del usuario. Aqui nunca se borra nada.
    $pasted = $false
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        if (-not (Test-Placeholder (Get-ComposerValue $handle))) {
            $pasted = $true
            break
        }
        Start-Sleep -Milliseconds 300
    }

    if (-not $pasted) {
        Write-Output 'ERROR: el compositor quedo vacio tras pegar; no se envia (no se borra nada)'
        exit 4
    }

    if ($NoSubmit) {
        if (-not (Clear-Composer)) {
            Write-Output 'ERROR: no pude limpiar el compositor'
            exit 8
        }
        Write-Output 'OK_SIN_ENVIAR'
        exit 0
    }

    # Si la sesion empezo a trabajar durante el pegado, Enter encolaria la orden: se deja
    # el texto escrito y se avisa, para que el usuario decida enviarlo a mano.
    if (Test-SessionBusy $handle) {
        Write-Output 'ERROR: la sesion empezo a trabajar durante el pegado; el texto queda escrito y no se envia'
        exit 10
    }

    # Se pulsa el boton real del compositor ("Enviar"), no Enter a ciegas: Enter depende
    # del estado del editor y con la sesion ocupada encola en vez de enviar.
    $sendButton = Find-RawButton $handle 'Enviar'
    if (-not $sendButton) { $sendButton = Find-RawButton $handle 'Send' }
    if ($sendButton) {
        try {
            if ($sendButton.Current.IsEnabled) {
                $invoke = $sendButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
                $invoke.Invoke()
            }
        } catch { }
    }

    # Enviado = el compositor se vacia solo (vuelve a mostrar el placeholder).
    $submitted = $false
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        if (Test-Placeholder (Get-ComposerValue $handle)) {
            $submitted = $true
            break
        }
        Start-Sleep -Milliseconds 250
    }

    if (-not $submitted -and (Test-FocusIsPrompt)) {
        # Ultimo recurso, solo con el foco verificado en el compositor y sin boton util.
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
        for ($attempt = 0; $attempt -lt 8; $attempt++) {
            if (Test-Placeholder (Get-ComposerValue $handle)) {
                $submitted = $true
                break
            }
            Start-Sleep -Milliseconds 250
        }
    }

    if (-not $submitted) {
        Write-Output 'ERROR: el texto quedo escrito pero no consegui enviarlo; no se borra nada'
        exit 6
    }

    Start-Sleep -Milliseconds 300

    # Tras enviar, el editor se vacia solo. No se borra nada por si el usuario ya esta
    # escribiendo otra cosa; solo se le devuelve el foco para que pueda teclear.
    $afterControl = Find-PromptControl $root
    if ($afterControl) {
        try { $afterControl.SetFocus() } catch { }
    }

    Write-Output 'OK_ENVIADA'
    exit 0
} catch {
    # Nunca se borra el compositor aqui: si algo fallo, el texto puede estar escrito y
    # el usuario prefiere enviarlo a mano antes que perderlo.
    Write-Output ("ERROR: " + $_.Exception.Message)
    exit 7
} finally {
    # Devolver el portapapeles no debe poder cambiar el resultado: si falla, se ignora.
    try { if ($clipboardBackup) { Set-Clipboard -Value $clipboardBackup } } catch { }
}
