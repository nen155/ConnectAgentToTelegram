param(
    [string]$Project,
    [string]$PromptFile,
    [switch]$DryRun,
    # Pega y limpia (Ctrl+U) sin enviar. Para probar sin lanzar nada.
    [switch]$NoSubmit,
    # Devuelve en JSON las ventanas del IDE abiertas y su proyecto.
    [switch]$ListWindows,
    # Sufijo del titulo de las ventanas del IDE (" - Devin" en Devin Desktop).
    [string]$WindowSuffix = ' - Devin',
    # Texto que debe aparecer en el terminal (nombre o clase) para confirmar que es el
    # agente y no un shell cualquiera. Sin coincidencia no se escribe nada.
    [string]$Expect = ''
)

# Envia una orden a la TERMINAL INTEGRADA del IDE, para agentes que viven en una TUI
# (OpenCode, Codex, Claude Code). Es una ruta opt-in: escribir en una terminal es
# inherentemente fragil, asi que se exige que el terminal se identifique con -Expect
# (p. ej. "opencode") antes de pegar nada.
#
# Limitacion conocida: xterm no expone su contenido por UI Automation, asi que no se
# puede comprobar el texto escrito. Las unicas garantias son el foco verificado en el
# terminal y la coincidencia con -Expect.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinTerm {
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
    $script:found = [IntPtr]::Zero
    $script:matchPrefix = "$name$suffix"
    $callback = [WinTerm+EnumWindowsProc]{
        param($handle, $state)
        if ([WinTerm]::IsWindowVisible($handle)) {
            $buffer = New-Object System.Text.StringBuilder 512
            [void][WinTerm]::GetWindowText($handle, $buffer, 512)
            $title = $buffer.ToString()
            if ($title.StartsWith($script:matchPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { $script:found = $handle }
        }
        return $true
    }
    [void][WinTerm]::EnumWindows($callback, [IntPtr]::Zero)
    return $script:found
}

if ($ListWindows) {
    $script:all = @()
    $listCallback = [WinTerm+EnumWindowsProc]{
        param($handle, $state)
        if ([WinTerm]::IsWindowVisible($handle)) {
            $buffer = New-Object System.Text.StringBuilder 512
            [void][WinTerm]::GetWindowText($handle, $buffer, 512)
            $title = $buffer.ToString()
            $index = $title.IndexOf($script:windowSuffix)
            if ($index -gt 0) {
                $script:all += [pscustomobject]@{
                    project = $title.Substring(0, $index)
                    title   = $title
                }
            }
        }
        return $true
    }
    [void][WinTerm]::EnumWindows($listCallback, [IntPtr]::Zero)
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
if ($handle -eq [IntPtr]::Zero) {
    Write-Output "SIN_VENTANA: no hay ninguna ventana '$Project$WindowSuffix' abierta"
    exit 2
}

# La terminal integrada no esta en el arbol de control: se busca en el raw por clase
# (xterm) o por nombre (Terminal). Solo se acepta si ademas coincide con -Expect.
function Find-Terminal($root, [string]$expect) {
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $stack = New-Object System.Collections.Stack
    $stack.Push($root)
    while ($stack.Count -gt 0) {
        $parent = $stack.Pop()
        $child = $walker.GetFirstChild($parent)
        while ($child) {
            try {
                $info = $child.Current
                $name = [string]$info.Name
                $class = [string]$info.ClassName
                $help = [string]$info.HelpText
                $looksTerminal = ($class -like '*xterm*') -or ($name -like '*Terminal*')
                if ($looksTerminal) {
                    $haystack = "$name $class $help"
                    if (-not $expect -or $haystack.ToLower().Contains($expect.ToLower())) {
                        return $child
                    }
                }
            } catch { }
            $stack.Push($child)
            $child = $walker.GetNextSibling($child)
        }
    }
    return $null
}

$root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
$terminal = Find-Terminal $root $Expect
if (-not $terminal) {
    if ($Expect) {
        Write-Output "TERMINAL_NO_COINCIDE: no hay terminal con '$Expect' en la ventana de '$Project'"
        exit 11
    }
    Write-Output "SIN_TERMINAL: la ventana de '$Project' no tiene una terminal integrada visible"
    exit 3
}

if ($DryRun) {
    $info = $terminal.Current
    Write-Output ("OK_DRY: terminal='" + $info.Name + "' class='" + $info.ClassName + "'")
    exit 0
}

function Test-FocusIsTerminal($element) {
    try {
        $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
        if (-not $focused) { return $false }
        $current = $focused.Current
        $target = $element.Current
        return ($current.ClassName -eq $target.ClassName) -and ($current.Name -eq $target.Name)
    } catch {
        return $false
    }
}

function Set-WindowForeground([IntPtr]$handle) {
    [void][WinTerm]::ShowWindow($handle, 9)
    if ([WinTerm]::GetForegroundWindow() -eq $handle) { return $true }

    [WinTerm]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
    [void][WinTerm]::SetForegroundWindow($handle)
    Start-Sleep -Milliseconds 150
    [WinTerm]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 400
    return ([WinTerm]::GetForegroundWindow() -eq $handle)
}

$clipboardBackup = ''
try { $clipboardBackup = [string](Get-Clipboard -Raw -ErrorAction Stop) } catch { }

try {
    if (-not (Set-WindowForeground $handle)) {
        Write-Output 'ERROR: no pude activar la ventana del IDE; no se envia'
        exit 5
    }

    $terminal.SetFocus()
    Start-Sleep -Milliseconds 500
    if (-not (Test-FocusIsTerminal $terminal)) {
        Write-Output 'ERROR: no consegui el foco en la terminal; no se envia'
        exit 5
    }

    Set-Clipboard -Value $prompt
    Start-Sleep -Milliseconds 120
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 600

    if (-not (Test-FocusIsTerminal $terminal)) {
        Write-Output 'ERROR: el foco se movio durante el pegado; no se envia'
        exit 6
    }

    if ($NoSubmit) {
        # Ctrl+U borra la linea en readline; en una TUI puede no hacer nada, pero no
        # se pulsa Enter, asi que no se ejecuta la orden.
        [System.Windows.Forms.SendKeys]::SendWait('^u')
        Write-Output 'OK_SIN_ENVIAR'
        exit 0
    }

    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Start-Sleep -Milliseconds 600
    Write-Output 'OK_ENVIADA'
    exit 0
} catch {
    Write-Output ("ERROR: " + $_.Exception.Message)
    exit 7
} finally {
    try { if ($clipboardBackup) { Set-Clipboard -Value $clipboardBackup } } catch { }
}
