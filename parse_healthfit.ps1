# Full Garmin FIT binary parser in PowerShell for Divan's HealthFit Cycling workouts
$healthFitDir = if ($env:HEALTHFIT_DIR) { $env:HEALTHFIT_DIR } else { Join-Path $env:USERPROFILE 'Downloads\HealthFit\HealthFit' }
$outputJson = Join-Path $PSScriptRoot 'data\divan_cycling_history.json'

Write-Host "Scanning $healthFitDir for cycling FIT files..."

$allFiles = Get-ChildItem -Path $healthFitDir -Filter "*Cycling*.fit"
Write-Host "Found $($allFiles.Count) cycling workout files."

function Parse-FitFile ($filePath) {
    try {
        $bytes = [System.IO.File]::ReadAllBytes($filePath)
        if ($bytes.Length -lt 14) { return $null }
        
        $headerSize = $bytes[0]
        $tag = [System.Text.Encoding]::ASCII.GetString($bytes[8..11])
        if ($tag -ne ".FIT") { return $null }
        
        $dataSize = [System.BitConverter]::ToUInt32($bytes, 4)
        $endPos = [Math]::Min($bytes.Length, ($headerSize + $dataSize))
        
        $offset = $headerSize
        $defs = @{}
        $records = [System.Collections.Generic.List[PSObject]]::new()
        $session = $null
        $lastTimestamp = 0
        
        while ($offset -lt $endPos) {
            $headerByte = $bytes[$offset]
            $offset++
            
            $isCompressed = ($headerByte -band 0x80) -ne 0
            if ($isCompressed) {
                # Compressed timestamp data message
                $localId = ($headerByte -band 0x60) -shr 5
                $timeOffset = $headerByte -band 0x1F
                if (-not $defs.ContainsKey($localId)) { break }
                $def = $defs[$localId]
                
                # Timestamp reconstruction
                $lastTimestamp = ($lastTimestamp -band 0xFFFFFFE0) + $timeOffset
                
                $dataMsg = Read-DataMessage $bytes ([ref]$offset) $def
                if ($def.GlobalMesg -eq 20) {
                    $dataMsg["timestamp"] = $lastTimestamp
                    $records.Add($dataMsg)
                }
            } else {
                $isDefinition = ($headerByte -band 0x40) -ne 0
                $hasDevData = ($headerByte -band 0x20) -ne 0
                $localId = $headerByte -band 0x0F
                
                if ($isDefinition) {
                    if ($offset + 5 -gt $bytes.Length) { break }
                    $reserved = $bytes[$offset]
                    $arch = $bytes[$offset + 1] # 0 = little, 1 = big
                    $isBigEndian = ($arch -eq 1)
                    
                    if ($isBigEndian) {
                        $globalMesg = ($bytes[$offset + 2] -shl 8) -bor $bytes[$offset + 3]
                    } else {
                        $globalMesg = $bytes[$offset + 2] -bor ($bytes[$offset + 3] -shl 8)
                    }
                    
                    $numFields = $bytes[$offset + 4]
                    $offset += 5
                    
                    $fields = [System.Collections.Generic.List[PSObject]]::new()
                    for ($i = 0; $i -lt $numFields; $i++) {
                        if ($offset + 3 -gt $bytes.Length) { break }
                        $fNum = $bytes[$offset]
                        $fSize = $bytes[$offset + 1]
                        $fType = $bytes[$offset + 2]
                        $offset += 3
                        $fields.Add(@{ Num = $fNum; Size = $fSize; Type = $fType })
                    }
                    
                    if ($hasDevData) {
                        if ($offset -lt $bytes.Length) {
                            $numDevFields = $bytes[$offset]
                            $offset++
                            $offset += ($numDevFields * 3)
                        }
                    }
                    
                    $defs[$localId] = @{
                        GlobalMesg = $globalMesg
                        IsBigEndian = $isBigEndian
                        Fields = $fields
                    }
                } else {
                    # Data Message
                    if (-not $defs.ContainsKey($localId)) { break }
                    $def = $defs[$localId]
                    $dataMsg = Read-DataMessage $bytes ([ref]$offset) $def
                    
                    if ($def.GlobalMesg -eq 20) {
                        # Trackpoint Record
                        if ($dataMsg.ContainsKey("timestamp")) {
                            $lastTimestamp = $dataMsg["timestamp"]
                        }
                        $records.Add($dataMsg)
                    } elseif ($def.GlobalMesg -eq 18) {
                        # Session
                        $session = $dataMsg
                    }
                }
            }
        }
        
        return @{
            Session = $session
            Records = $records
        }
    } catch {
        return $null
    }
}

function Read-DataMessage ($bytes, [ref]$offsetRef, $def) {
    $msg = @{}
    $off = $offsetRef.Value
    $isBig = $def.IsBigEndian
    
    foreach ($f in $def.Fields) {
        $fNum = $f.Num
        $fSize = $f.Size
        $fType = $f.Type
        
        if ($off + $fSize -gt $bytes.Length) { break }
        
        # Read raw value
        if ($fSize -eq 1) {
            $val = $bytes[$off]
            if ($val -ne 0xFF) {
                if ($fNum -eq 3) { $msg["heart_rate"] = [int]$val }
                elseif ($fNum -eq 4) { $msg["cadence"] = [int]$val }
                elseif ($fNum -eq 9) { $msg["left_right_balance"] = [int]$val }
                elseif ($fNum -eq 5) { $msg["sport"] = [int]$val }
                elseif ($fNum -eq 16) { $msg["avg_heart_rate"] = [int]$val }
                elseif ($fNum -eq 17) { $msg["max_heart_rate"] = [int]$val }
                elseif ($fNum -eq 18) { $msg["avg_cadence"] = [int]$val }
                elseif ($fNum -eq 19) { $msg["max_cadence"] = [int]$val }
            }
        } elseif ($fSize -eq 2) {
            $val = 0
            if ($isBig) {
                $val = ($bytes[$off] -shl 8) -bor $bytes[$off + 1]
            } else {
                $val = $bytes[$off] -bor ($bytes[$off + 1] -shl 8)
            }
            if ($val -ne 0xFFFF) {
                if ($fNum -eq 7) { $msg["power"] = [int]$val }
                elseif ($fNum -eq 6) { $msg["speed"] = [double]($val / 1000.0) }
                elseif ($fNum -eq 20) { $msg["avg_power"] = [int]$val }
                elseif ($fNum -eq 21) { $msg["max_power"] = [int]$val }
                elseif ($fNum -eq 25) { $msg["normalized_power"] = [int]$val }
                elseif ($fNum -eq 26) { $msg["tss"] = [double]($val / 10.0) }
                elseif ($fNum -eq 27) { $msg["intensity_factor"] = [double]($val / 1000.0) }
                elseif ($fNum -eq 11) { $msg["total_calories"] = [int]$val }
            }
        } elseif ($fSize -eq 4) {
            $val = 0
            if ($isBig) {
                $val = ($bytes[$off] -shl 24) -bor ($bytes[$off + 1] -shl 16) -bor ($bytes[$off + 2] -shl 8) -bor $bytes[$off + 3]
            } else {
                $val = $bytes[$off] -bor ($bytes[$off + 1] -shl 8) -bor ($bytes[$off + 2] -shl 16) -bor ($bytes[$off + 3] -shl 24)
            }
            if ($val -ne 0xFFFFFFFF) {
                if ($fNum -eq 253) { $msg["timestamp"] = [uint32]$val }
                elseif ($fNum -eq 5) { $msg["distance"] = [double]($val / 100.0) }
                elseif ($fNum -eq 7) { $msg["total_elapsed_time"] = [double]($val / 1000.0) }
                elseif ($fNum -eq 8) { $msg["total_timer_time"] = [double]($val / 1000.0) }
                elseif ($fNum -eq 9) { $msg["total_distance"] = [double]($val / 100.0) }
            }
        }
        
        $off += $fSize
    }
    
    $offsetRef.Value = $off
    return $msg
}

$processedRides = [System.Collections.Generic.List[PSObject]]::new()
$allPowersForMmp = @{} # duration -> max watts
$peak20mPowerOverall = 0
$maxHrOverall = 0

foreach ($file in $allFiles) {
    $parsed = Parse-FitFile $file.FullName
    if ($null -eq $parsed) { continue }
    
    $records = $parsed.Records
    $sess = $parsed.Session
    
    # Extract date from filename or session
    # e.g., "2026-09-19-100127-Indoor Cycling-HealthFit.fit"
    $baseName = $file.BaseName
    $parts = $baseName -split "-"
    $isoDate = ""
    if ($parts.Length -ge 4) {
        $year = $parts[0]
        $month = $parts[1]
        $day = $parts[2]
        $timePart = $parts[3]
        if ($timePart.Length -ge 6) {
            $h = $timePart.Substring(0, 2)
            $m = $timePart.Substring(2, 2)
            $s = $timePart.Substring(4, 2)
            $isoDate = "${year}-${month}-${day}T${h}:${m}:${s}Z"
        }
    }
    
    # Analyze records
    $powers = [System.Collections.Generic.List[int]]::new()
    $hrs = [System.Collections.Generic.List[int]]::new()
    $cads = [System.Collections.Generic.List[int]]::new()
    
    foreach ($rec in $records) {
        if ($rec.ContainsKey("power")) {
            $p = [int]$rec["power"]
            $powers.Add($p)
        } else {
            $powers.Add(0)
        }
        if ($rec.ContainsKey("heart_rate")) {
            $h = [int]$rec["heart_rate"]
            $hrs.Add($h)
            if ($h -gt $maxHrOverall) { $maxHrOverall = $h }
        }
        if ($rec.ContainsKey("cadence")) {
            $cads.Add([int]$rec["cadence"])
        }
    }
    
    $durationSec = $powers.Count
    if ($durationSec -lt 180) { continue } # skip trivial snippets under 3 mins
    
    # Compute averages
    $avgWatts = 0
    if ($powers.Count -gt 0) {
        $avgWatts = [int](($powers | Measure-Object -Average).Average)
    }
    $maxWatts = 0
    if ($powers.Count -gt 0) {
        $maxWatts = [int](($powers | Measure-Object -Maximum).Maximum)
    }
    
    $avgHr = 0
    if ($hrs.Count -gt 0) { $avgHr = [int](($hrs | Measure-Object -Average).Average) }
    $maxHr = 0
    if ($hrs.Count -gt 0) { $maxHr = [int](($hrs | Measure-Object -Maximum).Maximum) }
    
    $avgCad = 0
    if ($cads.Count -gt 0) { $avgCad = [int](($cads | Measure-Object -Average).Average) }
    
    # True Coggan 30s 4th power NP calculation
    $np = $avgWatts
    if ($powers.Count -ge 30) {
        $rolling30 = [System.Collections.Generic.List[double]]::new()
        $curSum = 0
        for ($i = 0; $i -lt 30; $i++) { $curSum += $powers[$i] }
        $rolling30.Add($curSum / 30.0)
        
        for ($i = 30; $i -lt $powers.Count; $i++) {
            $curSum += $powers[$i] - $powers[$i - 30]
            $rolling30.Add($curSum / 30.0)
        }
        
        $fourthSum = 0.0
        foreach ($r in $rolling30) {
            $fourthSum += [Math]::Pow($r, 4)
        }
        $np = [int][Math]::Round([Math]::Pow(($fourthSum / $rolling30.Count), 0.25))
    }
    
    # Calculate best 20m power for this ride
    $best20m = 0
    if ($powers.Count -ge 1200) {
        $curSum20 = 0
        for ($i = 0; $i -lt 1200; $i++) { $curSum20 += $powers[$i] }
        $best20m = $curSum20 / 1200.0
        
        for ($i = 1200; $i -lt $powers.Count; $i++) {
            $curSum20 += $powers[$i] - $powers[$i - 1200]
            $mean20 = $curSum20 / 1200.0
            if ($mean20 -gt $best20m) { $best20m = $mean20 }
        }
    }
    if ($best20m -gt $peak20mPowerOverall) {
        $peak20mPowerOverall = [int][Math]::Round($best20m)
    }
    
    # Baseline FTP estimation (temp 250 for TSS if not yet determined)
    $baselineFtp = 250
    $ifVal = [Math]::Round(($np / $baselineFtp), 2)
    $tss = [int][Math]::Round(($durationSec * $np * $ifVal) / ($baselineFtp * 36.0))
    $kj = [int][Math]::Round(($avgWatts * $durationSec) / 1000.0)
    
    $cleanTitle = $baseName -replace "^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}-", "" -replace "-", " "
    
    $processedRides.Add(@{
        id = "ride_fit_" + $file.Name.GetHashCode()
        title = $cleanTitle
        date = $isoDate
        duration = $durationSec
        durationMin = [int][Math]::Round($durationSec / 60.0)
        avgWatts = $avgWatts
        maxWatts = $maxWatts
        np = $np
        if = $ifVal
        tss = $tss
        kj = $kj
        avgHr = $avgHr
        maxHr = $maxHr
        avgCadence = $avgCad
        source = "HealthFit FIT"
        fileName = $file.Name
        samplesCount = $powers.Count
    })
}

Write-Host "Processed $($processedRides.Count) valid cycling rides."
Write-Host "Peak 20-min Power: ${peak20mPowerOverall}W"
Write-Host "Max Observed Heart Rate: ${maxHrOverall} BPM"

$calculatedFtp = [int][Math]::Round($peak20mPowerOverall * 0.95)
if ($calculatedFtp -lt 150) { $calculatedFtp = 240 }

Write-Host "Estimated FTP (95% of 20m peak): ${calculatedFtp}W"

# Re-calculate true TSS and IF with calculated FTP
foreach ($r in $processedRides) {
    $r.if = [Math]::Round(($r.np / [double]$calculatedFtp), 2)
    $r.tss = [int][Math]::Round(($r.duration * $r.np * $r.if) / ($calculatedFtp * 36.0))
}

$summaryData = @{
    riderName = "Divan"
    estimatedFtp = $calculatedFtp
    peak20mPower = $peak20mPowerOverall
    maxHeartRate = $maxHrOverall
    totalRides = $processedRides.Count
    rides = ($processedRides | Sort-Object -Property date -Descending)
}

$jsonStr = $summaryData | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($outputJson, $jsonStr)

Write-Host "Successfully exported Divan's cycling history to $outputJson!"
