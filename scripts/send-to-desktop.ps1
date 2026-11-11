param(
    [Parameter(Mandatory = $true)][string]$Project,
    [Parameter(Mandatory = $true)][string]$PromptFile,
    [switch]$DryRun,
    # Escribe y verifica, pero borra el texto en vez de enviarlo. Para probar sin lanzar nada.
    [switch]$NoSubmit
)

# Envia una orden al compositor de la ventana de Devin Desktop cuyo titulo empieza por el
# nombre del proyecto. Se escribe por UI Automation (ValuePattern) en el control 'Prompt',
# no con teclas a ciegas, y solo se pulsa Enter si el texto quedo realmente escrito.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnum {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder t, int c);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
"@

function Find-ProjectWindow([string]$name) {
    $script:found = $null
    $callback = [WinEnum+EnumWindowsProc]{
        param($handle, $state)
        if ([WinEnum]::IsWindowVisible($handle)) {
            $buffer = New-Object System.Text.StringBuilder 512
            [void][WinEnum]::GetWindowText($handle, $buffer, 512)
            $title = $buffer.ToString()
            if ($title -like "$name - Devin*") { $script:found = $handle }
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

if (-not (Test-Path $PromptFile)) {
    Write-Output 'ERROR: no existe el archivo con la orden'
    exit 1
}
$prompt = [System.IO.File]::ReadAllText($PromptFile, [System.Text.Encoding]::UTF8).Trim()
if (-not $prompt) {
    Write-Output 'ERROR: la orden esta vacia'
    exit 1
}

$handle = Find-ProjectWindow $Project
if (-not $handle) {
    Write-Output "SIN_VENTANA: no hay ninguna ventana '$Project - Devin' abierta"
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

try {
    $valuePattern = $promptControl.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $promptControl.SetFocus()
    Start-Sleep -Milliseconds 350

    $valuePattern.SetValue($prompt)
    Start-Sleep -Milliseconds 450

    # Solo se envia si el texto esta realmente en el compositor y el foco sigue ahi.
    $written = $valuePattern.Current.Value
    if ($written -ne $prompt) {
        Write-Output 'ERROR: el compositor no acepto el texto; no se envia'
        exit 4
    }

    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if (-not [System.Windows.Automation.Automation]::Compare($focused, $promptControl)) {
        Write-Output 'ERROR: el foco se movio antes de enviar; no se envia'
        exit 5
    }

    if ($NoSubmit) {
        $valuePattern.SetValue('')
        Start-Sleep -Milliseconds 250
        Write-Output 'OK_SIN_ENVIAR'
        exit 0
    }

    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Start-Sleep -Milliseconds 300

    Write-Output 'OK_ENVIADA'
    exit 0
} catch {
    Write-Output ("ERROR: " + $_.Exception.Message)
    exit 6
}
