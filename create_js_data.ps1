$jsonPath = Join-Path $PSScriptRoot 'data\divan_cycling_history.json'
$jsPath = Join-Path $PSScriptRoot 'data\divan_cycling_history.js'

$jsonContent = [System.IO.File]::ReadAllText($jsonPath)
$jsContent = "window.DIVAN_HEALTHFIT_DATA = " + $jsonContent + ";"
[System.IO.File]::WriteAllText($jsPath, $jsContent)
Write-Host "Created $jsPath successfully!"
