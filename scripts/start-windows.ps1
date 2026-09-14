param(
    [Parameter(Mandatory = $true)][string[]]$LibraryRoots,
    [string]$DataDir = "$env:LOCALAPPDATA\Musimo\data",
    [string]$PotServerHome = '',
    [ValidateRange(1024, 65535)][int]$Port = 8765
)

$ErrorActionPreference = 'Stop'
$projectDir = Split-Path $PSScriptRoot -Parent
$pythonPath = Join-Path $projectDir '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) { throw 'Run uv sync --locked first.' }
if (-not (Test-Path -LiteralPath "$projectDir\frontend\dist\index.html")) {
    throw 'Build the frontend first: npm run build --prefix frontend'
}
$resolvedRoots = foreach ($libraryRoot in $LibraryRoots) {
    if (-not (Test-Path -LiteralPath $libraryRoot -PathType Container)) {
        throw "Music folder is missing: $libraryRoot"
    }
    (Resolve-Path -LiteralPath $libraryRoot).Path
}
foreach ($toolName in 'ffmpeg', 'ffprobe', 'deno', 'fpcalc', 'node') {
    if (-not (Get-Command $toolName -ErrorAction SilentlyContinue)) {
        throw "Required tool is missing from PATH: $toolName"
    }
}
if ($PotServerHome) {
    if (-not (Test-Path -LiteralPath "$PotServerHome\build\generate_once.js")) {
        throw 'Build the matching bgutil helper before starting Musimo.'
    }
    $env:MUSIMO_POT_SERVER_HOME = (Resolve-Path -LiteralPath $PotServerHome).Path
}
$env:MUSIMO_DATA_DIR = [IO.Path]::GetFullPath($DataDir)
$env:MUSIMO_STATIC_DIR = Join-Path $projectDir 'frontend\dist'
$env:MUSIMO_LIBRARY_ROOTS = $resolvedRoots -join [IO.Path]::PathSeparator
$env:MUSIMO_WATCH_MODE = 'native'
$env:PYTHONUNBUFFERED = '1'
Set-Location -LiteralPath $projectDir
& $pythonPath -m uvicorn backend.main:app --host 127.0.0.1 --port $Port --workers 1 --no-access-log --forwarded-allow-ips '127.0.0.1,::1' --timeout-graceful-shutdown 5
exit $LASTEXITCODE
