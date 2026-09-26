# Usage: .\test_header.ps1 <path-to-file.fit>
if (-not $args[0]) { Write-Host 'Usage: .\test_header.ps1 <path-to-file.fit>'; exit 1 }
$path = $args[0]
$bytes = [System.IO.File]::ReadAllBytes($path)
Write-Output ("File size: " + $bytes.Length)
$headerSize = $bytes[0]
$tag = [System.Text.Encoding]::ASCII.GetString($bytes[8..11])
$dataSize = [System.BitConverter]::ToUInt32($bytes, 4)
Write-Output ("HeaderSize: $headerSize, Tag: $tag, DataSize: $dataSize")
