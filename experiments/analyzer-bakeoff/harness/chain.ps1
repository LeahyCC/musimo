# The whole bake-off, in order, one job at a time so timings are not shared. See
# docs/analyzer-bakeoff.md. Runners skip songs that already have a record, so a rerun only
# fills gaps; delete an out/ folder to measure it again.
#   $env:BAKEOFF_MUSIC = 'M:/Media/Music'   # check the drive letter first
#   powershell -File experiments/analyzer-bakeoff/harness/chain.ps1 [-Steps sample,deezer,...]
param(
    [string[]]$Steps = @('sample', 'deezer', 'build', 'analyse', 'score')
)
# powershell -File passes "-Steps a,b" as the single string 'a,b'. Split it here.
$Steps = @($Steps | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$known = @('sample', 'deezer', 'build', 'analyse', 'essentia', 'score')
$unknown = @($Steps | Where-Object { $known -notcontains $_ })
if ($unknown) { throw "unknown step(s): $($unknown -join ', '); expected $($known -join ', ')" }
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
# Native commands do not stop a script when they fail. Log the exit and stop, so a later step
# never runs on a stale sample or a stale image.
function Check([string]$what) {
    if ($LASTEXITCODE -ne 0) {
        Log "$what failed, exit $LASTEXITCODE"
        throw "$what failed with exit $LASTEXITCODE"
    }
}

if ($Steps -contains 'sample') {
    # The trial stack holds the DB copy and has no route out. Read it, then stop it again.
    $trial = @('compose', '-f', "$repo/runtime/tempo-trial/compose.yaml", '-p', 'musimo-tempo-trial',
        '--env-file', "$repo/runtime/tempo-trial/.env")
    docker @trial up -d --wait musimo
    Check 'trial stack start'
    try {
        docker cp "$here/harness/export_sample.py" musimo-tempo-trial-musimo-1:/tmp/export_sample.py
        Check 'copy export script'
        docker exec musimo-tempo-trial-musimo-1 python -I /tmp/export_sample.py /tmp/sample.json
        Check 'export sample'
        docker cp musimo-tempo-trial-musimo-1:/tmp/sample.json "$runtime/sample.json"
        Check 'copy sample out'
    } finally {
        docker exec musimo-tempo-trial-musimo-1 rm -f /tmp/export_sample.py /tmp/sample.json
        docker @trial stop musimo
    }
    Log 'sample exported'
}
if ($Steps -contains 'deezer') {
    & $uv run --no-project --python 3.12 python -I "$here/harness/deezer_bpm.py" `
        "$runtime/sample.json" "$runtime/out/deezer.json" *> "$runtime/logs/deezer.log"
    Check 'deezer'
    Log 'deezer done'
}
if ($Steps -contains 'build') {
    docker @compose build beat-this essentia *> "$runtime/logs/build.log"
    Check 'build'
    Log 'build done'
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
        Check $name
        Log "end $name"
    }
}
if ($Steps -contains 'score') {
    & $uv run --no-project --python 3.12 --with numpy python -I "$here/harness/score.py" $runtime 0.15
    Check 'score'
    Log 'score done'
}
