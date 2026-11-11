param(
    [ValidateSet('tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo')]
    [string]$Model = 'small',
    [string]$Tag = 'v1.9.2',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$whisperDir = Join-Path $root 'vendor\whisper'
$modelsDir = Join-Path $root 'vendor\models'
New-Item -ItemType Directory -Force -Path $whisperDir, $modelsDir | Out-Null

$exe = Join-Path $whisperDir 'whisper-cli.exe'
if (-not (Test-Path $exe) -or $Force) {
    $url = "https://github.com/ggml-org/whisper.cpp/releases/download/$Tag/whisper-bin-x64.zip"
    $zip = Join-Path $env:TEMP "whisper-bin-x64-$Tag.zip"

    Write-Host "Descargando whisper.cpp $Tag ..."
    curl.exe -L --fail --retry 3 -o $zip $url
    if ($LASTEXITCODE -ne 0) { throw "No se pudo descargar $url" }

    Write-Host "Descomprimiendo en $whisperDir ..."
    Expand-Archive -Path $zip -DestinationPath $whisperDir -Force
    Remove-Item $zip -Force

    # El zip trae el binario dentro de una subcarpeta (p.ej. Release/): se aplana
    # para que el .exe quede junto a sus DLL.
    $found = Get-ChildItem -Path $whisperDir -Recurse -File |
        Where-Object { $_.Name -in @('whisper-cli.exe', 'main.exe') } |
        Select-Object -First 1

    if (-not $found) {
        throw "No se encontro whisper-cli.exe tras descomprimir. Revisa el contenido de $whisperDir"
    }

    $sourceDir = $found.Directory.FullName
    if ($sourceDir -ne $whisperDir) {
        Get-ChildItem -Path $sourceDir -File | Copy-Item -Destination $whisperDir -Force
        Remove-Item $sourceDir -Recurse -Force
    }

    # Versiones antiguas publican main.exe en lugar de whisper-cli.exe.
    if (-not (Test-Path $exe) -and (Test-Path (Join-Path $whisperDir 'main.exe'))) {
        Copy-Item (Join-Path $whisperDir 'main.exe') $exe
    }
    if (-not (Test-Path $exe)) {
        throw "No se pudo preparar whisper-cli.exe en $whisperDir"
    }
}

$modelPath = Join-Path $modelsDir "ggml-$Model.bin"
if (-not (Test-Path $modelPath) -or $Force) {
    $modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$Model.bin"
    Write-Host "Descargando modelo $Model (puede tardar varios minutos) ..."
    curl.exe -L --fail --retry 3 -C - -o $modelPath $modelUrl
    if ($LASTEXITCODE -ne 0) { throw "No se pudo descargar el modelo $Model" }
}

$sizeMb = [math]::Round((Get-Item $modelPath).Length / 1MB, 1)
Write-Host ""
Write-Host "whisper.cpp listo:" -ForegroundColor Green
Write-Host "  binario: $exe"
Write-Host "  modelo : $modelPath ($sizeMb MB)"
Write-Host ""
Write-Host "Si quieres otro modelo: npm run setup:whisper -- -Model medium"
