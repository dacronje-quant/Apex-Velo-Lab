# Calculate true MMP curve for Divan from FIT files
$healthFitDir = if ($env:HEALTHFIT_DIR) { $env:HEALTHFIT_DIR } else { Join-Path $env:USERPROFILE 'Downloads\HealthFit\HealthFit' }
$fitFiles = Get-ChildItem -Path $healthFitDir -Filter "*Cycling*.fit"

# Durations in seconds: 5s, 15s, 30s, 60s (1m), 180s (3m), 300s (5m), 600s (10m), 1200s (20m), 3600s (60m)
$durations = @(5, 15, 30, 60, 180, 300, 600, 1200, 3600)
$mmpRecords = @{}
foreach ($d in $durations) { $mmpRecords[$d] = 0 }

# We'll reuse the Parse-FitFile function from parse_healthfit.ps1
. (Join-Path $PSScriptRoot 'parse_healthfit.ps1')

foreach ($file in $fitFiles) {
    $parsed = Parse-FitFile $file.FullName
    if ($null -eq $parsed) { continue }
    $powers = [System.Collections.Generic.List[int]]::new()
    foreach ($r in $parsed.Records) {
        if ($r.ContainsKey("power")) { $powers.Add([int]$r["power"]) }
        else { $powers.Add(0) }
    }
    if ($powers.Count -lt 10) { continue }
    
    foreach ($d in $durations) {
        if ($powers.Count -ge $d) {
            $curSum = 0
            for ($i = 0; $i -lt $d; $i++) { $curSum += $powers[$i] }
            $maxAvg = $curSum / [double]$d
            for ($i = $d; $i -lt $powers.Count; $i++) {
                $curSum += $powers[$i] - $powers[$i - $d]
                $avg = $curSum / [double]$d
                if ($avg -gt $maxAvg) { $maxAvg = $avg }
            }
            if ($maxAvg -gt $mmpRecords[$d]) {
                $mmpRecords[$d] = [int][Math]::Round($maxAvg)
            }
        }
    }
}

Write-Host "Divan's True All-Time MMP Curve (W):"
foreach ($d in $durations) {
    Write-Host "${d}s: $($mmpRecords[$d])W"
}

$mmpArray = @($mmpRecords[5], $mmpRecords[15], $mmpRecords[30], $mmpRecords[60], $mmpRecords[180], $mmpRecords[300], $mmpRecords[600], $mmpRecords[1200], $mmpRecords[3600])
Write-Host "MMP Array: $($mmpArray -join ', ')"
