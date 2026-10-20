# The whole bake-off, in order, one job at a time so timings are not shared. See
# docs/analyzer-bakeoff.md. Runners skip songs that already have a record, so a rerun only
# fills gaps; delete an out/ folder to measure it again.
#   $env:BAKEOFF_MUSIC = 'M:/Media/Music'   # check the drive letter first
#   powershell -File experiments/analyzer-bakeoff/harness/chain.ps1 [-Steps sample,deezer,...]
param(
    [string[]]$Steps = @('sample', 'deezer', 'build', 'analyse', 'score')
)
$repo = (Resolve-Path "$PSScriptRoot/../../..").Path
$here = Join-Path $repo 'experiments/analyzer-bakeoff'
$runtime = Join-Path $repo 'runtime/analyzer-bakeoff'
$uv = Join-Path $HOME '.local/bin/uv'
if (-not $env:BAKEOFF_MUSIC -or -not (Test-Path $env:BAKEOFF_MUSIC)) {
    throw "BAKEOFF_MUSIC must name the music folder, found '$env:BAKEOFF_MUSIC'"
}
New-Item -ItemType Directory -Force "$runtime/out", "$runtime/logs" | Out-Null
$compose = @('compose', '-f', "$here/compose.yaml", '-p', 'musimo-analyzer-bakeoff')

function Log([string]$text) { "$(Get-Date -Format o) $text" | Add-Content "$runtime/logs/chain.log" }

if ($Steps -contains 'sample') {
    # The trial stack holds the DB copy and has no route out. Read it, then stop it again.
    $trial = @('compose', '-f', "$repo/runtime/tempo-trial/compose.yaml", '-p', 'musimo-tempo-trial',
        '--env-file', "$repo/runtime/tempo-trial/.env")
    docker @trial up -d --wait musimo
    try {
        docker cp "$here/harness/export_sample.py" musimo-tempo-trial-musimo-1:/tmp/export_sample.py
        docker exec musimo-tempo-trial-musimo-1 python -I /tmp/export_sample.py /tmp/sample.json
        docker cp musimo-tempo-trial-musimo-1:/tmp/sample.json "$runtime/sample.json"
        docker exec musimo-tempo-trial-musimo-1 rm -f /tmp/export_sample.py /tmp/sample.json
    } finally {
        docker @trial stop musimo
    }
    Log 'sample exported'
}
if ($Steps -contains 'deezer') {
    & $uv run --no-project --python 3.12 python -I "$here/harness/deezer_bpm.py" `
        "$runtime/sample.json" "$runtime/out/deezer.json" *> "$runtime/logs/deezer.log"
    Log "deezer exit $LASTEXITCODE"
}
if ($Steps -contains 'build') {
    docker @compose build beat-this essentia *> "$runtime/logs/build.log"
    Log "build exit $LASTEXITCODE"
}
if ($Steps -contains 'analyse' -or $Steps -contains 'essentia') {
    $jobs = @(
        @('beat-this', 'beat_this-final0', @('final0', '/out/beat_this-final0', 'tempo_ids')),
        @('beat-this', 'beat_this-final0-extra', @('final0', '/out/beat_this-final0-extra', 'tempo_extra_ids')),
        @('librosa', 'librosa', @('/out/librosa', 'tempo_ids')),
        @('librosa', 'librosa-extra', @('/out/librosa-extra', 'tempo_extra_ids')),
        @('essentia', 'essentia', @('/out/essentia')),
        @('beat-this', 'beat_this-small0', @('small0', '/out/beat_this-small0', 'tempo_ids'))
    )
    if ($Steps -notcontains 'analyse') { $jobs = @($jobs | Where-Object { $_[1] -eq 'essentia' }) }
    foreach ($job in $jobs) {
        $service, $name, $arguments = $job
        Log "start $name"
        docker @compose run --rm --name "bakeoff-$name" $service @arguments *> "$runtime/logs/$name.log"
        Log "end $name exit $LASTEXITCODE"
    }
}
if ($Steps -contains 'score') {
    & $uv run --no-project --python 3.12 --with numpy python -I "$here/harness/score.py" $runtime 0.15
    Log "score exit $LASTEXITCODE"
}
