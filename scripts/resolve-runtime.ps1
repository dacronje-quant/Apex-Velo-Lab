# First-run setup: use a compatible installed runtime, otherwise fetch a verified portable copy.
# Nothing is installed globally. Subsequent launches work offline.
function Resolve-ApexRuntime {
    $ErrorActionPreference = 'Stop'
    function Test-ApexRuntime([string]$candidate) {
        if (-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $false }
        try {
            $probe = & $candidate -e "if(Number(process.versions.node.split('.')[0])<24)process.exit(1);const d=new(require('node:sqlite').DatabaseSync)(':memory:');d.close();" 2>$null
            return $LASTEXITCODE -eq 0
        } catch { return $false }
    }
    if ($env:APEX_NODE_EXE) {
        if (Test-ApexRuntime $env:APEX_NODE_EXE) { return $env:APEX_NODE_EXE }
        throw 'APEX_NODE_EXE does not point to a compatible runtime.'
    }
    $installed = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $env:APEX_FORCE_PORTABLE_RUNTIME -and $installed -and (Test-ApexRuntime $installed.Source)) { return $installed.Source }
    $runtimeDir = if ($env:APEX_RUNTIME_DIR) { $env:APEX_RUNTIME_DIR } else { Join-Path $env:LOCALAPPDATA 'ApexVeloLab/runtime' }
    $runtimeDir = [System.IO.Path]::GetFullPath($runtimeDir)
    $exe = Join-Path $runtimeDir 'node.exe'
    if (Test-ApexRuntime $exe) { return $exe }
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    $version = 'v24.21.0'
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
    $relative = "win-$arch/node.exe"
    $base = "https://nodejs.org/dist/$version"
    $tmp = Join-Path $runtimeDir ('node-' + [guid]::NewGuid().ToString('N') + '.download')
    Write-Host 'Preparing Apex for first use. Downloading its portable runtime...' -ForegroundColor Cyan
    try {
        [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
        $checksums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt" -TimeoutSec 60).Content
        $expected = $null
        foreach ($line in ($checksums -split "`n")) {
            if ($line.Trim() -match '^([a-fA-F0-9]{64})\s+(.+)$' -and $Matches[2] -eq $relative) { $expected = $Matches[1] }
        }
        if (-not $expected) { throw 'Could not verify the runtime download metadata.' }
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$relative" -OutFile $tmp -TimeoutSec 180
        if ((Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash -ne $expected) { throw 'Runtime checksum did not match. Launch Apex again to retry.' }
        Move-Item -LiteralPath $tmp -Destination $exe -Force
        if (-not (Test-ApexRuntime $exe)) { throw 'The downloaded runtime could not start.' }
        return $exe
    } catch {
        throw "Setup could not finish: $($_.Exception.Message) Your saved data is untouched. Check the internet connection and launch Apex again."
    } finally {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
    }
}
