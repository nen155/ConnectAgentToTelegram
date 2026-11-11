param(
    [string]$TextFile,
    [string]$OutFile,
    [string]$Voice,
    [int]$Rate = 0,
    [switch]$ListVoices
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

try {
    if ($ListVoices) {
        $synth.GetInstalledVoices() |
            Where-Object { $_.Enabled } |
            ForEach-Object { "{0} | {1} | {2}" -f $_.VoiceInfo.Name, $_.VoiceInfo.Culture.Name, $_.VoiceInfo.Gender }
        return
    }

    if (-not $TextFile -or -not $OutFile) {
        throw 'Uso: sapi-tts.ps1 -TextFile <ruta> -OutFile <ruta.wav> [-Voice <nombre o cultura>] [-Rate -10..10]'
    }

    if ($Voice) {
        $match = $synth.GetInstalledVoices() |
            Where-Object { $_.Enabled } |
            Where-Object { $_.VoiceInfo.Name -like "*$Voice*" -or $_.VoiceInfo.Culture.Name -like "*$Voice*" } |
            Select-Object -First 1

        if ($match) {
            $synth.SelectVoice($match.VoiceInfo.Name)
        } else {
            Write-Warning "Voz '$Voice' no instalada; se usa la predeterminada del sistema."
        }
    }

    $synth.Rate = $Rate
    $text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($text)) { throw 'El archivo de texto esta vacio.' }

    $synth.SetOutputToWaveFile($OutFile)
    $synth.Speak($text)
}
finally {
    $synth.Dispose()
}
