$jsonPath = Join-Path $PSScriptRoot '..\data\local-history.json'
$jsPath = Join-Path $PSScriptRoot '..\data\local-history.js'

$jsonContent = [System.IO.File]::ReadAllText($jsonPath)
$jsContent = "window.APEX_LOCAL_HISTORY = " + $jsonContent + ";"
[System.IO.File]::WriteAllText($jsPath, $jsContent)
Write-Host "Created $jsPath successfully!"
