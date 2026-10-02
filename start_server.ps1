# APEX VELO LAB - local web server + AI coach proxy (Windows PowerShell 5.1 or PowerShell 7).
#
# - Serves the app on http://localhost:8080 (a secure context, so Web Bluetooth works).
# - Forwards AI Coach requests from /api/coach to the Claude API or the Gemini API. The API keys
#   are read here, from the ANTHROPIC_API_KEY / GEMINI_API_KEY environment variables or the .env
#   file next to this script. They are never sent to the browser, and .env is never served.
# Keep the port stable: the browser stores your rides and settings per address (localhost:8080).

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)

# ------------------------------------------------------------------ config --
$keyFromEnvironment = -not [string]::IsNullOrWhiteSpace($env:ANTHROPIC_API_KEY)
$geminiKeyFromEnvironment = -not [string]::IsNullOrWhiteSpace($env:GEMINI_API_KEY)
$settings = @{}
$envFile = Join-Path $root '.env'
if (Test-Path $envFile -PathType Leaf) {
    foreach ($raw in [System.IO.File]::ReadAllLines($envFile)) {
        $line = $raw.Trim().TrimStart([char]0xFEFF)
        if ($line -eq '' -or $line.StartsWith('#')) { continue }
        if ($line -match '^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $name = $Matches[1]; $val = $Matches[2].Trim()
            if (($val.StartsWith('"') -and $val.EndsWith('"') -and $val.Length -ge 2) -or ($val.StartsWith("'") -and $val.EndsWith("'") -and $val.Length -ge 2)) {
                $val = $val.Substring(1, $val.Length - 2)
            } else {
                $val = ($val -replace '\s+#.*$', '')
            }
            $settings[$name] = $val
        }
    }
}
function Get-Setting([string]$name, [string]$default) {
    if ($settings.ContainsKey($name) -and $settings[$name] -ne '') { return $settings[$name] }
    return $default
}

# Models the coach may use. Haiku 4.5 has no adaptive thinking or effort, so it uses a fixed thinking budget.
# For Gemini the effort setting maps to thinkingLevel (low / medium / high).
$models = [ordered]@{
    'claude-opus-5-5'           = @{ label = 'Claude Opus 5.5';          provider = 'claude'; adaptive = $true }
    'claude-sonnet-5'           = @{ label = 'Claude Sonnet 5';          provider = 'claude'; adaptive = $true }
    'claude-haiku-4-5-20251001' = @{ label = 'Claude Haiku 4.5';         provider = 'claude'; adaptive = $false }
    'gemini-3.8-flash'          = @{ label = 'Gemini 3.8 Flash';         provider = 'gemini'; adaptive = $true }
    'gemini-3.1-pro-preview'    = @{ label = 'Gemini 3.1 Pro (preview)'; provider = 'gemini'; adaptive = $true }
    'gemini-3.1-flash-lite'     = @{ label = 'Gemini 3.1 Flash-Lite';    provider = 'gemini'; adaptive = $true }
}
$providers = [ordered]@{
    'claude' = @{ label = 'Claude'; keyName = 'ANTHROPIC_API_KEY'; fallbackModel = 'claude-opus-5-5' }
    'gemini' = @{ label = 'Gemini'; keyName = 'GEMINI_API_KEY';    fallbackModel = 'gemini-3.8-flash' }
}
$efforts = @('low', 'medium', 'high')

# A key set as an environment variable wins over .env; the APEX_* settings come from .env.
$apiKey = if ($keyFromEnvironment) { $env:ANTHROPIC_API_KEY.Trim() } else { (Get-Setting 'ANTHROPIC_API_KEY' '').Trim() }
$geminiKey = if ($geminiKeyFromEnvironment) { $env:GEMINI_API_KEY.Trim() } else { (Get-Setting 'GEMINI_API_KEY' '').Trim() }
$keys = @{ claude = $apiKey; gemini = $geminiKey }
function Select-Model([string]$id, [string]$provider) {
    if ($models.Contains($id) -and $models[$id].provider -eq $provider) { return $id }
    return $providers[$provider].fallbackModel
}
$defaultModels = @{
    claude = Select-Model (Get-Setting 'APEX_COACH_MODEL' '') 'claude'
    gemini = Select-Model (Get-Setting 'APEX_GEMINI_MODEL' '') 'gemini'
}
# Default provider: APEX_COACH_PROVIDER if set, otherwise whichever has a key (Claude first).
$defaultProvider = Get-Setting 'APEX_COACH_PROVIDER' ''
if (-not $providers.Contains($defaultProvider)) { $defaultProvider = if ($apiKey -eq '' -and $geminiKey -ne '') { 'gemini' } else { 'claude' } }
$defaultModel = $defaultModels[$defaultProvider]
$defaultEffort = Get-Setting 'APEX_COACH_EFFORT' 'low'
if ($efforts -notcontains $defaultEffort) { $defaultEffort = 'low' }
$port = [int](Get-Setting 'APEX_PORT' '8080')
$apiBase = (Get-Setting 'APEX_ANTHROPIC_BASE_URL' 'https://api.anthropic.com').TrimEnd('/')
$geminiBase = (Get-Setting 'APEX_GEMINI_BASE_URL' 'https://generativelanguage.googleapis.com').TrimEnd('/')
$maxBodyBytes = 256KB

$systemPrompt = "You are an elite cycling coach and exercise physiologist. You prescribe structured indoor ERG sessions " +
    "from the rider's real training data. Be specific and evidence-based, never invent data that is not in the request, " +
    "and use the requested response format (JSON when requested, otherwise plain text or markdown). " +
    "Explain things to a beginner in short, everyday sentences. Lead with what to do and why it helps. " +
    "Avoid sports-science jargon and acronyms in advice: say fitness base, recent training strain, and freshness instead of CTL, ATL, and TSB. " +
    "If a technical term is essential, explain it immediately in plain words. Use numbers only when needed to act, such as ride duration or a power target; " +
    "do not repeat training scores, percentages, or tables of statistics in prose. Keep numeric workout fields and schema keys exact. " +
    "Treat calculated scores as estimates, not proof of illness, overtraining, or full recovery. Be respectful and concise."

# Ask: a separate data analyst for free questions about the rider's own training (the coach above builds workouts).
# Kept identical to ASK_SYSTEM_PROMPT in server.js.
$askSystemPrompt = "You are the rider's personal cycling data analyst inside the Apex Velo Lab app. " +
    "Answer questions about their training using only the TRAINING DATA block and what the rider tells you in this conversation. " +
    "Never invent rides, numbers or dates. If the data cannot answer the question, say exactly what is missing and how the rider could get it " +
    "(for example: ride with the heart-rate strap, or pick a longer period). " +
    "Start with the direct answer in one or two sentences. Then give the evidence as up to five short bullet points with the actual numbers and dates. " +
    "End with one practical takeaway when it helps. Keep the whole answer short unless the rider asks for detail. " +
    "Use plain English for someone who is not a sports scientist. The first time you use an acronym, add its plain meaning in brackets, " +
    "for example TSS (workout load score), CTL (fitness base), ATL (recent strain), TSB (freshness), NP (surge-weighted average power), " +
    "CP (long-effort limit) or W' (burst energy reserve). " +
    "Treat calculated scores as estimates, not proof of illness, overtraining or full recovery, and do not diagnose health problems: suggest a professional for health worries. " +
    "For a full workout or a training plan, point the rider to the Coach tab. " +
    "Format with short markdown: bold the key numbers, use bullet lists, and keep any table to four columns or fewer."
$askMaxMessages = 40
$askMaxMessageChars = 20000
$askMaxContextChars = 150000
# Server-side refusal fallback (Claude Opus 5.5): a declined request is re-run on Anthropic's recommended model.
$fallbackBeta = 'server-side-fallback-2026-07-01'

# HTTP client for the Claude and Gemini APIs (TLS 1.2+ is required; older .NET defaults may not enable it).
Add-Type -AssemblyName System.Net.Http
try { [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12 } catch { }
$http = New-Object System.Net.Http.HttpClient
$http.Timeout = [TimeSpan]::FromSeconds(180)
$utf8 = New-Object System.Text.UTF8Encoding($false)

# ------------------------------------------------------------------ helpers --
function Send-Bytes($response, [int]$status, [byte[]]$bytes, [string]$type) {
    $response.StatusCode = $status
    $response.ContentType = $type
    $response.Headers['Cache-Control'] = 'no-store'
    $response.Headers['X-Content-Type-Options'] = 'nosniff'
    $response.ContentLength64 = $bytes.Length
    if ($bytes.Length -gt 0) { $response.OutputStream.Write($bytes, 0, $bytes.Length) }
    $response.Close()
}
function Send-Text($response, [int]$status, [string]$text) {
    Send-Bytes $response $status $utf8.GetBytes($text) 'text/plain; charset=utf-8'
}
function Send-Json($response, [int]$status, $obj) {
    Send-Bytes $response $status $utf8.GetBytes(($obj | ConvertTo-Json -Depth 8 -Compress)) 'application/json; charset=utf-8'
}
function Send-RawJson($response, [int]$status, [string]$json) {
    Send-Bytes $response $status $utf8.GetBytes($json) 'application/json; charset=utf-8'
}
# Only pages served by this server may call the API: blocks other websites and DNS rebinding.
# Private-LAN IPv4 ranges, so a phone on the same home Wi-Fi can use the app too (never a public address).
$lanHostRe = '^(10(\.\d{1,3}){3}|172\.(1[6-9]|2\d|3[0-1])(\.\d{1,3}){2}|192\.168(\.\d{1,3}){2}|169\.254(\.\d{1,3}){2})(:\d+)?$'
# The real client address (not a header a client can set) must be this PC or a private home
# network address - so even on a cafe Wi-Fi nothing outside answers. (Same as server.js.)
function Test-AllowedClient($request) {
    $addr = $request.RemoteEndPoint.Address
    if ($null -eq $addr) { return $false }
    if ($addr.IsIPv4MappedToIPv6) { $addr = $addr.MapToIPv4() }
    if ([System.Net.IPAddress]::IsLoopback($addr)) { return $true }
    $ip = $addr.ToString()
    return (($ip -match '^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)') -or ($ip -match '^(f[cd][0-9a-f]{2}|fe80):'))
}

function Test-LocalRequest($request) {
    $h = [string]$request.Headers['Host']
    $hostOk = ($h -match '^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$') -or ($h -match $lanHostRe)
    $origin = $request.Headers['Origin']
    $originOk = [string]::IsNullOrEmpty($origin) -or ($origin -match '^http://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$') -or (($origin -replace '^https?://', '') -match $lanHostRe)
    return ($hostOk -and $originOk)
}

# ------------------------------------------------ automatic backups (this PC only) --
# The app posts its history backup (the same JSON as "Backup JSON", gzipped in the browser) after
# changes and once a day. Kept in data\backups (the newest $backupKeep), never served. (Same as server.js.)
$backupDir = [System.IO.Path]::Combine($root, 'data', 'backups')
$backupKeep = 14
$backupMaxBytes = 200MB
$backupNameRe = '^apex_velo_backup_\d{4}-\d{2}-\d{2}_\d{6}\.json\.gz$'
$backupPrefix = '{"app":"APEX VELO LAB"'

# Only the app opened on this PC (not a phone on the Wi-Fi) may read or write backups.
function Test-PcRequest($request) {
    $h = [string]$request.Headers['Host']
    $origin = $request.Headers['Origin']
    return (($h -match '^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$') -and ([string]::IsNullOrEmpty($origin) -or ($origin -match '^http://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$')))
}

function Get-BackupFiles {
    if (-not (Test-Path -LiteralPath $backupDir)) { return @() }
    return @(Get-ChildItem -LiteralPath $backupDir -File | Where-Object { $_.Name -match $backupNameRe } | Sort-Object Name)
}

function Get-BackupStatus {
    $files = Get-BackupFiles
    $latest = $null
    if ($files.Count) { $f = $files[$files.Count - 1]; $latest = [ordered]@{ name = $f.Name; bytes = $f.Length; at = $f.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ') } }
    return [ordered]@{ dir = $backupDir; count = $files.Count; keep = $backupKeep; latest = $latest }
}

function Invoke-Backup($request, $response) {
    if (-not (Test-PcRequest $request)) { return Send-Json $response 403 @{ error = 'Backups can only be made from the app on this PC.' } }
    if ($request.HttpMethod -eq 'GET') { return Send-Json $response 200 (Get-BackupStatus) }
    if ($request.HttpMethod -ne 'POST') { return Send-Json $response 405 @{ error = 'Method not allowed' } }
    if ($request.ContentType -notmatch '^application/gzip\b') { return Send-Json $response 415 @{ error = 'Content-Type must be application/gzip.' } }
    if ($request.ContentLength64 -gt $backupMaxBytes) { return Send-Json $response 413 @{ error = 'Backup too large' } }
    $ms = New-Object System.IO.MemoryStream
    $request.InputStream.CopyTo($ms)
    $bytes = $ms.ToArray(); $ms.Dispose()
    if ($bytes.Length -gt $backupMaxBytes) { return Send-Json $response 413 @{ error = 'Backup too large' } }
    # Only an Apex Velo Lab backup is accepted (gzip, and it starts like one).
    $head = ''
    try {
        $gz = New-Object System.IO.Compression.GZipStream((New-Object System.IO.MemoryStream(, $bytes)), [System.IO.Compression.CompressionMode]::Decompress)
        $buf = New-Object byte[] $backupPrefix.Length
        $read = 0
        while ($read -lt $buf.Length) { $n = $gz.Read($buf, $read, $buf.Length - $read); if ($n -le 0) { break }; $read += $n }
        $gz.Dispose()
        $head = $utf8.GetString($buf, 0, $read)
    } catch { $head = '' }
    if ($head -ne $backupPrefix) { return Send-Json $response 400 @{ error = 'Not an Apex Velo Lab backup.' } }
    $name = 'apex_velo_backup_' + (Get-Date).ToString('yyyy-MM-dd_HHmmss') + '.json.gz'
    try {
        [void][System.IO.Directory]::CreateDirectory($backupDir)
        $tmp = Join-Path $backupDir ('.' + $name + '.tmp')
        [System.IO.File]::WriteAllBytes($tmp, $bytes)
        Move-Item -LiteralPath $tmp -Destination (Join-Path $backupDir $name) -Force   # a half-written file never looks like a backup
        $files = Get-BackupFiles
        if ($files.Count -gt $backupKeep) { $files | Select-Object -First ($files.Count - $backupKeep) | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue } }
    } catch {
        return Send-Json $response 500 @{ error = "Could not write the backup ($($_.Exception.Message))." }
    }
    $st = Get-BackupStatus
    return Send-Json $response 200 ([ordered]@{ ok = $true; name = $name; bytes = $bytes.Length; dir = $st.dir; count = $st.count; keep = $st.keep; latest = $st.latest })
}

# ------------------------------------------------ Apple Health (Health Auto Export) --
# The Health Auto Export iPhone app POSTs its JSON to /api/health with "Authorization: Bearer <token>".
# Payloads are stored as-is in data\health\inbox; the app on this PC reads them (parsing lives in
# js\velo-health.js), then acknowledges them so they are deleted. data\health is never served. (Same as server.js.)
$healthDir = [System.IO.Path]::Combine($root, 'data', 'health')
$healthInbox = [System.IO.Path]::Combine($healthDir, 'inbox')
$healthTokenFile = [System.IO.Path]::Combine($healthDir, 'token.txt')
$healthMetaFile = [System.IO.Path]::Combine($healthDir, 'status.json')
$healthMaxBytes = 50MB
$healthInboxKeep = 500
$healthNameRe = '^hae_\d{8}_\d{6}_[0-9a-f]{6}\.json$'

function Get-HealthToken([bool]$renew = $false) {
    if (-not $renew -and (Test-Path -LiteralPath $healthTokenFile)) {
        $t = ([System.IO.File]::ReadAllText($healthTokenFile)).Trim()
        if ($t -match '^[0-9a-f]{32,}$') { return $t }
    }
    $b = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    $t = -join ($b | ForEach-Object { $_.ToString('x2') })
    [void][System.IO.Directory]::CreateDirectory($healthDir)
    [System.IO.File]::WriteAllText($healthTokenFile, $t)
    return $t
}

function Get-HealthInboxFiles {
    if (-not (Test-Path -LiteralPath $healthInbox)) { return @() }
    return @(Get-ChildItem -LiteralPath $healthInbox -File | Where-Object { $_.Name -match $healthNameRe } | Sort-Object Name)
}

function Get-LanAddresses {
    try {
        return @([System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
            Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' } |
            ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
            Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' -and $_.Address.ToString() -match $lanHostRe } |
            ForEach-Object { $_.Address.ToString() })
    } catch { return @() }
}

function Get-HealthStatus {
    $meta = $null
    if (Test-Path -LiteralPath $healthMetaFile) { try { $meta = [System.IO.File]::ReadAllText($healthMetaFile) | ConvertFrom-Json } catch { $meta = $null } }
    $ips = @(Get-LanAddresses)
    return [ordered]@{
        token = (Get-HealthToken); port = $port
        urls = @($ips | ForEach-Object { "http://${_}:$port/api/health" })
        phoneUrls = @($ips | ForEach-Object { "http://${_}:$port/live.html" })
        inbox = @(Get-HealthInboxFiles).Count
        lastReceived = $(if ($meta) { $meta.lastReceived } else { $null })
        lastBytes = $(if ($meta) { [int64]$meta.lastBytes } else { 0 })
        received = $(if ($meta) { [int]$meta.received } else { 0 })
    }
}

function Test-HealthToken([string]$given) {
    $want = Get-HealthToken
    if ([string]::IsNullOrEmpty($given) -or $given.Length -ne $want.Length) { return $false }
    $diff = 0
    for ($i = 0; $i -lt $want.Length; $i++) { $diff = $diff -bor ([int][char]$want[$i] -bxor [int][char]$given[$i]) }
    return ($diff -eq 0)
}

function Invoke-Health($request, $response, [string]$path) {
    if ($path -eq '/api/health' -and $request.HttpMethod -eq 'POST') {
        # From the phone: the bearer token is the gate (the address check already limits it to this PC / home Wi-Fi).
        $auth = [string]$request.Headers['Authorization']
        $given = ($auth -replace '^Bearer\s+', '').Trim()
        if ($given -eq '') { $given = [string]$request.QueryString['token'] }
        if (-not (Test-HealthToken $given)) { return Send-Json $response 401 @{ error = 'Missing or wrong token - copy it from Settings > Apple Health in the app.' } }
        if ($request.ContentLength64 -gt $healthMaxBytes) { return Send-Json $response 413 @{ error = 'Over 50 MB - export a shorter date range.' } }
        $ms = New-Object System.IO.MemoryStream
        $request.InputStream.CopyTo($ms)
        $bytes = $ms.ToArray(); $ms.Dispose()
        if ($bytes.Length -gt $healthMaxBytes) { return Send-Json $response 413 @{ error = 'Over 50 MB - export a shorter date range.' } }
        try { $body = $utf8.GetString($bytes) | ConvertFrom-Json } catch { return Send-Json $response 400 @{ error = 'Invalid JSON.' } }
        if ($null -eq $body -or -not ($body.data -or $body.metrics)) { return Send-Json $response 400 @{ error = 'Not a Health Auto Export payload (no "data").' } }
        $rb = New-Object byte[] 3
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($rb)
        $name = 'hae_' + (Get-Date).ToString('yyyyMMdd_HHmmss') + '_' + (-join ($rb | ForEach-Object { $_.ToString('x2') })) + '.json'
        try {
            [void][System.IO.Directory]::CreateDirectory($healthInbox)
            $tmp = Join-Path $healthInbox ('.' + $name + '.tmp')
            [System.IO.File]::WriteAllBytes($tmp, $bytes)
            Move-Item -LiteralPath $tmp -Destination (Join-Path $healthInbox $name) -Force
            $files = Get-HealthInboxFiles
            if ($files.Count -gt $healthInboxKeep) { $files | Select-Object -First ($files.Count - $healthInboxKeep) | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue } }
            $prev = 0
            if (Test-Path -LiteralPath $healthMetaFile) { try { $prev = [int](([System.IO.File]::ReadAllText($healthMetaFile) | ConvertFrom-Json).received) } catch { $prev = 0 } }
            $meta = [ordered]@{ lastReceived = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ'); lastBytes = $bytes.Length; received = $prev + 1 }
            [System.IO.File]::WriteAllText($healthMetaFile, ($meta | ConvertTo-Json -Compress))
        } catch {
            return Send-Json $response 500 @{ error = "Could not save the data ($($_.Exception.Message))." }
        }
        return Send-Json $response 200 ([ordered]@{ ok = $true; stored = $name })
    }
    # Everything else - the token, the stored data - only for the app on this PC.
    if (-not (Test-PcRequest $request)) { return Send-Json $response 403 @{ error = 'Only the app on this PC can read Apple Health data.' } }
    if ($path -eq '/api/health/status' -and $request.HttpMethod -eq 'GET') { return Send-Json $response 200 (Get-HealthStatus) }
    if ($path -eq '/api/health/token' -and $request.HttpMethod -eq 'POST') { [void](Get-HealthToken $true); return Send-Json $response 200 (Get-HealthStatus) }
    if ($path -eq '/api/health/inbox' -and $request.HttpMethod -eq 'GET') {
        $all = @(Get-HealthInboxFiles)
        $take = @($all | Select-Object -First 20)
        # Stream the stored JSON through untouched (no re-serialisation of the phone's data).
        $parts = @(foreach ($f in $take) {
            $txt = [System.IO.File]::ReadAllText($f.FullName, $utf8).Trim()
            try { $null = $txt | ConvertFrom-Json } catch { $txt = 'null' }
            if ($txt -eq '') { $txt = 'null' }
            '{"name":"' + $f.Name + '","body":' + $txt + '}'
        })
        $remaining = [Math]::Max(0, $all.Count - $take.Count)
        return Send-RawJson $response 200 ('{"files":[' + ($parts -join ',') + '],"remaining":' + $remaining + '}')
    }
    if ($path -eq '/api/health/ack' -and $request.HttpMethod -eq 'POST') {
        if ($request.ContentLength64 -gt 65536) { return Send-Json $response 413 @{ error = 'Request too large' } }
        $reader = New-Object System.IO.StreamReader($request.InputStream, $utf8)
        $bodyText = $reader.ReadToEnd(); $reader.Close()
        try { $b = $bodyText | ConvertFrom-Json } catch { return Send-Json $response 400 @{ error = 'Invalid JSON.' } }
        $removed = 0
        foreach ($n in @($b.names)) {
            $n = [string]$n
            if ($n -notmatch $healthNameRe) { continue }
            $fp = Join-Path $healthInbox $n
            if (Test-Path -LiteralPath $fp) { Remove-Item -LiteralPath $fp -Force -ErrorAction SilentlyContinue; $removed++ }
        }
        return Send-Json $response 200 ([ordered]@{ ok = $true; removed = $removed })
    }
    return Send-Json $response 404 @{ error = 'Not found' }
}

# ---------------------------------------------------------------- phone view --
# The PC app posts a live snapshot right after every ride tick; live.html on the phone reads it
# and queues simple commands. Memory only.
# Low latency without polling: the phone asks GET /api/live?after=<seq> and that request is held
# (not answered) until the next snapshot arrives, at most $liveHoldMs (long-poll). The PC app
# holds GET /api/live/cmds open the same way, so a tapped command reaches it at once. Held
# requests are just parked responses, so this single-threaded loop never blocks on them.
# Every command has an id and stays queued until the PC confirms it (cmdAck in its next
# publish), so a command is never lost on a dropped connection and never applied twice.
$liveCmdsAllowed = @('toggle', 'skip', 'bias-up', 'bias-down', 'bias-reset', 'watts-up', 'watts-down', 'stand', 'spin-more', 'spin-finish',
    'connect-trainer', 'connect-pedals', 'connect-hr', 'connect-fan', 'disconnect-trainer', 'disconnect-pedals', 'disconnect-hr', 'disconnect-fan', 'connect-all', 'connect-stop', 'pair-cancel', 'calibrate-pedals',
    'fan-0', 'fan-25', 'fan-50', 'fan-75', 'fan-100', 'fan-mode-manual', 'fan-mode-hr', 'fan-mode-power')
$liveHoldMs = 2500
$liveCmdHoldMs = 20000
$liveMaxWaiters = 8
$liveCmdTtlMs = 10000
$script:liveSnapshotJson = 'null'
$script:liveAt = $null
$script:liveFit = $null
$script:liveSeq = 0
$script:liveCmds = New-Object System.Collections.ArrayList
$script:liveWaiters = New-Object System.Collections.ArrayList
$script:liveCmdWaiter = $null
$script:liveCmdId = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() # ids keep rising across restarts

function Get-LiveJson {
    $age = if ($script:liveAt) { [int]((Get-Date) - $script:liveAt).TotalMilliseconds } else { 'null' }
    $fitJson = 'null'
    if ($null -ne $script:liveFit) {
        $fitJson = @{ id = $script:liveFit.Id; filename = $script:liveFit.Filename; url = '/api/live/fit?id=' + $script:liveFit.Id } | ConvertTo-Json -Compress
    }
    return '{"snapshot":' + $script:liveSnapshotJson + ',"ageMs":' + $age + ',"pending":' + $script:liveCmds.Count + ',"seq":' + $script:liveSeq + ',"fit":' + $fitJson + '}'
}

# A normal attachment URL works in phone browsers over plain home-Wi-Fi HTTP.
# Only the PC may publish; the latest completed ride is kept in memory, never on disk.
function Invoke-LiveFit($request, $response) {
    if (-not (Test-LocalRequest $request)) { return Send-Json $response 403 @{ error = 'Forbidden' } }
    $id = [string]$request.QueryString['id']
    if ($request.HttpMethod -eq 'GET' -or $request.HttpMethod -eq 'HEAD') {
        if ($null -eq $script:liveFit -or $script:liveFit.Id -cne $id) { return Send-Json $response 404 @{ error = 'This FIT file is no longer available. Keep the PC app open until downloaded.' } }
        $response.Headers['Content-Disposition'] = 'attachment; filename="' + $script:liveFit.Filename + '"'
        if ($request.HttpMethod -eq 'HEAD') {
            $response.StatusCode = 200
            $response.ContentType = 'application/octet-stream'
            $response.Headers['Cache-Control'] = 'no-store'
            $response.Headers['X-Content-Type-Options'] = 'nosniff'
            $response.ContentLength64 = $script:liveFit.Bytes.Length
            return $response.Close()
        }
        return Send-Bytes $response 200 $script:liveFit.Bytes 'application/octet-stream'
    }
    if ($request.HttpMethod -ne 'POST') { return Send-Json $response 405 @{ error = 'Method not allowed' } }
    if (-not (Test-PcRequest $request)) { return Send-Json $response 403 @{ error = 'Only the app on this PC can publish FIT files.' } }
    $filename = [string]$request.QueryString['filename']
    if ($id -cnotmatch '^[a-zA-Z0-9_-]{1,80}$' -or $filename -cnotmatch '^[a-zA-Z0-9_-]{1,120}\.fit$') { return Send-Json $response 400 @{ error = 'Invalid FIT file name or ride id.' } }
    $limit = 16MB
    if ($request.ContentLength64 -gt $limit) { return Send-Json $response 413 @{ error = 'FIT file too large' } }
    $ms = New-Object System.IO.MemoryStream
    try {
        $buf = New-Object byte[] 8192
        while (($n = $request.InputStream.Read($buf, 0, $buf.Length)) -gt 0) {
            if ($ms.Length + $n -gt $limit) { return Send-Json $response 413 @{ error = 'FIT file too large' } }
            $ms.Write($buf, 0, $n)
        }
        $bytes = $ms.ToArray()
    } finally { $ms.Dispose() }
    if ($bytes.Length -lt 14 -or $bytes[0] -notin @(12, 14) -or [System.Text.Encoding]::ASCII.GetString($bytes, 8, 4) -cne '.FIT' -or ([long]$bytes[0] + [System.BitConverter]::ToUInt32($bytes, 4) + 2) -ne $bytes.Length) { return Send-Json $response 400 @{ error = 'Invalid FIT activity file.' } }
    $script:liveFit = @{ Id = $id; Filename = $filename; Bytes = $bytes }
    $script:liveSeq++
    Send-Json $response 200 @{ ok = $true }
    Send-LiveWaiters
}
# Commands newer than $after (expired ones are dropped), as the reply JSON.
function Get-LiveCmdsJson([long]$after) {
    $now = Get-Date
    foreach ($c in @($script:liveCmds)) { if (($now - $c.At).TotalMilliseconds -ge $liveCmdTtlMs) { $script:liveCmds.Remove($c) } }
    $parts = @(foreach ($c in $script:liveCmds) { if ($c.Id -gt $after) { '{"id":' + $c.Id + ',"cmd":"' + $c.Cmd + '"}' } })
    return '{"cmds":[' + ($parts -join ',') + ']}'
}
# A parked phone or PC may have gone away (screen locked, tab closed): a failed write is ignored.
function Complete-LiveWaiter($response, [string]$json) {
    try { Send-RawJson $response 200 $json; return $true } catch { try { $response.Abort() } catch { }; return $false }
}
function Send-LiveWaiters {
    if ($script:liveWaiters.Count -eq 0) { return }
    $json = Get-LiveJson
    foreach ($w in @($script:liveWaiters)) { [void](Complete-LiveWaiter $w.Response $json) }
    $script:liveWaiters.Clear()
}
function Send-LiveCmdWaiter {
    $w = $script:liveCmdWaiter
    if ($null -eq $w) { return }
    $json = Get-LiveCmdsJson $w.After
    if ($json -eq '{"cmds":[]}') { return }
    $script:liveCmdWaiter = $null
    # Stays queued until the PC confirms it, so a lost reply is repeated on the next publish.
    [void](Complete-LiveWaiter $w.Response $json)
}
# Called between requests: answer parked requests whose hold time is up.
function Update-LiveWaiters {
    $now = Get-Date
    if ($script:liveWaiters.Count -gt 0) {
        $json = $null
        foreach ($w in @($script:liveWaiters)) {
            if (($now - $w.At).TotalMilliseconds -ge $liveHoldMs) {
                if ($null -eq $json) { $json = Get-LiveJson }
                [void](Complete-LiveWaiter $w.Response $json)
                $script:liveWaiters.Remove($w)
            }
        }
    }
    $cw = $script:liveCmdWaiter
    if ($null -ne $cw -and ($now - $cw.At).TotalMilliseconds -ge $liveCmdHoldMs) {
        $script:liveCmdWaiter = $null
        [void](Complete-LiveWaiter $cw.Response '{"cmds":[]}')
    }
}

function Invoke-Live($request, $response) {
    if (-not (Test-LocalRequest $request)) { return Send-Json $response 403 @{ error = 'Forbidden' } }
    if ($request.HttpMethod -eq 'GET') {
        $after = $request.QueryString['after']
        $afterN = 0
        if ($null -ne $after -and [int]::TryParse($after, [ref]$afterN) -and $afterN -eq $script:liveSeq) {
            # Nothing newer than what the phone has: park it until the next snapshot (or the hold time).
            if ($script:liveWaiters.Count -ge $liveMaxWaiters) {
                $old = $script:liveWaiters[0]; $script:liveWaiters.RemoveAt(0)
                [void](Complete-LiveWaiter $old.Response (Get-LiveJson))
            }
            [void]$script:liveWaiters.Add(@{ Response = $response; At = (Get-Date) })
            return
        }
        return Send-RawJson $response 200 (Get-LiveJson)
    }
    if ($request.HttpMethod -ne 'POST') { return Send-Json $response 405 @{ error = 'Method not allowed' } }
    if ($request.ContentLength64 -gt 65536) { return Send-Json $response 413 @{ error = 'Request too large' } }
    $reader = New-Object System.IO.StreamReader($request.InputStream, $utf8)
    $bodyText = $reader.ReadToEnd(); $reader.Close()
    try { $b = $bodyText | ConvertFrom-Json } catch { return Send-Json $response 400 @{ error = 'Invalid JSON.' } }
    $script:liveSnapshotJson = $bodyText.Trim()
    if ($script:liveSnapshotJson -eq '') { $script:liveSnapshotJson = 'null' }
    $script:liveAt = Get-Date
    $script:liveSeq++
    $ack = $null
    if ($null -ne $b -and $null -ne $b.PSObject.Properties['cmdAck'] -and $null -ne $b.cmdAck) { try { $ack = [long]$b.cmdAck } catch { $ack = $null } }
    if ($null -ne $ack) {
        foreach ($c in @($script:liveCmds)) { if ($c.Id -le $ack) { $script:liveCmds.Remove($c) } }
        $json = Get-LiveCmdsJson $ack
    } else {
        $json = Get-LiveCmdsJson 0   # no ack: an older app, hand over once
        $script:liveCmds.Clear()
    }
    $fitIdJson = if ($null -ne $script:liveFit) { '"' + $script:liveFit.Id + '"' } else { 'null' }
    $json = $json.Substring(0, $json.Length - 1) + ',"fitId":' + $fitIdJson + '}'
    Send-RawJson $response 200 $json
    Send-LiveWaiters
}

function Invoke-LiveCmds($request, $response) {
    # Only the app on this PC collects commands.
    if (-not (Test-PcRequest $request)) { return Send-Json $response 403 @{ error = 'Forbidden' } }
    if ($request.HttpMethod -ne 'GET') { return Send-Json $response 405 @{ error = 'Method not allowed' } }
    $after = [long]0
    [void][long]::TryParse([string]$request.QueryString['after'], [ref]$after)
    $json = Get-LiveCmdsJson $after
    if ($json -ne '{"cmds":[]}') { return Send-RawJson $response 200 $json }
    if ($null -ne $script:liveCmdWaiter) { [void](Complete-LiveWaiter $script:liveCmdWaiter.Response '{"cmds":[]}') }
    $script:liveCmdWaiter = @{ Response = $response; At = (Get-Date); After = $after }
}

function Invoke-LiveCmd($request, $response) {
    if (-not (Test-LocalRequest $request)) { return Send-Json $response 403 @{ error = 'Forbidden' } }
    if ($request.HttpMethod -ne 'POST') { return Send-Json $response 405 @{ error = 'Method not allowed' } }
    if ($request.ContentLength64 -gt 1024) { return Send-Json $response 413 @{ error = 'Request too large' } }
    $reader = New-Object System.IO.StreamReader($request.InputStream, $utf8)
    $bodyText = $reader.ReadToEnd(); $reader.Close()
    try { $b = $bodyText | ConvertFrom-Json } catch { return Send-Json $response 400 @{ error = 'Invalid JSON.' } }
    $cmd = [string]$b.cmd
    if ($liveCmdsAllowed -notcontains $cmd) { return Send-Json $response 400 @{ error = 'Unknown command' } }
    if (-not $script:liveAt -or ((Get-Date) - $script:liveAt).TotalSeconds -gt 10) { return Send-Json $response 409 @{ error = 'The app on the PC is not open.' } }
    $newId = $null
    if ($script:liveCmds.Count -lt 20) { $script:liveCmdId++; $newId = $script:liveCmdId; [void]$script:liveCmds.Add(@{ Id = $script:liveCmdId; Cmd = $cmd; At = (Get-Date) }) }
    Send-LiveCmdWaiter   # wake the PC's open request first, then answer the phone
    Send-Json $response 200 ([ordered]@{ ok = $true; id = $newId })   # the phone shows the result at once and knows when the PC has applied it (cmdAck)
}

function Get-StatusObject {
    $list = @()
    foreach ($id in $models.Keys) { $list += [ordered]@{ id = $id; label = $models[$id].label; provider = $models[$id].provider; effort = $models[$id].adaptive } }
    $prov = [ordered]@{}
    foreach ($id in $providers.Keys) { $prov[$id] = [ordered]@{ label = $providers[$id].label; configured = ($keys[$id] -ne ''); model = $defaultModels[$id] } }
    return [ordered]@{ provider = $defaultProvider; providers = $prov; configured = ($keys[$defaultProvider] -ne ''); model = $defaultModel; effort = $defaultEffort; models = $list; efforts = $efforts }
}

function New-ClaudeMessage([string]$prompt, [string]$model, [string]$effort) {
    $req = [ordered]@{
        model      = $model
        max_tokens = 16000
        system     = $systemPrompt
        messages   = @(@{ role = 'user'; content = $prompt })
    }
    if ($models[$model].adaptive) {
        $req.thinking = [ordered]@{ type = 'adaptive'; display = 'summarized' }
        $req.output_config = @{ effort = $effort }
    } else {
        $req.thinking = [ordered]@{ type = 'enabled'; budget_tokens = 4000 }
    }
    $msg = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, "$apiBase/v1/messages")
    $msg.Headers.Add('x-api-key', $apiKey)
    $msg.Headers.Add('anthropic-version', '2023-06-01')
    $msg.Content = New-Object System.Net.Http.StringContent(($req | ConvertTo-Json -Depth 8 -Compress), $utf8, 'application/json')
    return $msg
}

function New-GeminiMessage([string]$prompt, [string]$model, [string]$effort) {
    $req = [ordered]@{
        systemInstruction = @{ parts = @(@{ text = $systemPrompt }) }
        contents          = @(@{ role = 'user'; parts = @(@{ text = $prompt }) })
        generationConfig  = [ordered]@{
            maxOutputTokens  = 16000
            responseMimeType = 'application/json'
            thinkingConfig   = [ordered]@{ thinkingLevel = $effort; includeThoughts = $true }
        }
    }
    $url = "$geminiBase/v1beta/models/$([System.Uri]::EscapeDataString($model)):generateContent"
    $msg = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, $url)
    $msg.Headers.Add('x-goog-api-key', $geminiKey)
    $msg.Content = New-Object System.Net.Http.StringContent(($req | ConvertTo-Json -Depth 10 -Compress), $utf8, 'application/json')
    return $msg
}

function Invoke-Coach($request, $response) {
    if (-not (Test-LocalRequest $request)) { return Send-Json $response 403 @{ error = 'Requests are only accepted from the app on localhost.' } }
    if ($request.ContentType -notmatch '^application/json\b') { return Send-Json $response 415 @{ error = 'Content-Type must be application/json.' } }
    if ($request.ContentLength64 -gt $maxBodyBytes) { return Send-Json $response 413 @{ error = 'Request too large' } }

    $reader = New-Object System.IO.StreamReader($request.InputStream, $utf8)
    $bodyText = $reader.ReadToEnd(); $reader.Close()
    if ($utf8.GetByteCount($bodyText) -gt $maxBodyBytes) { return Send-Json $response 413 @{ error = 'Request too large' } }
    try { $payload = $bodyText | ConvertFrom-Json } catch { return Send-Json $response 400 @{ error = 'Invalid JSON.' } }
    $prompt = if ($payload.prompt -is [string]) { $payload.prompt } else { '' }
    if ($prompt.Trim() -eq '' -or $prompt.Length -gt 100000) { return Send-Json $response 400 @{ error = 'A prompt of 1-100000 characters is required.' } }
    # The model decides the provider; without a (known) model, use the requested or default provider's default model.
    $knownModel = ($payload.model -is [string]) -and $models.Contains($payload.model)
    if ($knownModel) { $model = $payload.model; $provider = $models[$model].provider }
    else {
        $provider = if ($payload.provider -is [string] -and $providers.Contains($payload.provider)) { $payload.provider } else { $defaultProvider }
        $model = $defaultModels[$provider]
    }
    $effort = if ($payload.effort -is [string] -and $efforts -contains $payload.effort) { $payload.effort } else { $defaultEffort }
    $adaptive = $models[$model].adaptive
    $pLabel = $providers[$provider].label
    if ($keys[$provider] -eq '') { return Send-Json $response 503 @{ error = "No $pLabel API key. Add $($providers[$provider].keyName) to the .env file and restart Launch-Apex-Velo.bat." } }

    $msg = if ($provider -eq 'gemini') { New-GeminiMessage $prompt $model $effort } else { New-ClaudeMessage $prompt $model $effort }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $upstream = $http.SendAsync($msg).GetAwaiter().GetResult()
        $text = $utf8.GetString($upstream.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult())
    } catch {
        $inner = $_.Exception
        while ($inner.InnerException) { $inner = $inner.InnerException }
        $timedOut = ($inner -is [System.Threading.Tasks.TaskCanceledException]) -or ($inner -is [System.TimeoutException])
        Write-Host "[coach] $model $(if ($timedOut) { 'timed out' } else { 'request failed: ' + $inner.Message })" -ForegroundColor Yellow
        if ($timedOut) { return Send-Json $response 504 @{ error = "$pLabel did not answer in time." } }
        return Send-Json $response 502 @{ error = "Could not reach the $pLabel API ($($inner.Message))." }
    } finally { $msg.Dispose() }

    $data = $null
    try { $data = $text | ConvertFrom-Json } catch { }
    $code = [int]$upstream.StatusCode
    if (-not $upstream.IsSuccessStatusCode) {
        $err = if ($data -and $data.error -and $data.error.message) { $data.error.message } else { "HTTP $code" }
        Write-Host "[coach] $model failed: $code $err" -ForegroundColor Yellow
        return Send-Json $response 502 @{ error = "$pLabel API error ${code}: $err"; upstreamStatus = $code }
    }

    $outText = ''; $thinking = @()
    if ($provider -eq 'gemini') {
        $cand = if ($data -and $data.candidates) { @($data.candidates)[0] } else { $null }
        if (-not $cand) {
            $why = if ($data -and $data.promptFeedback -and $data.promptFeedback.blockReason) { $data.promptFeedback.blockReason } else { 'no answer' }
            Write-Host "[coach] $model returned no candidates ($why)" -ForegroundColor Yellow
            return Send-Json $response 502 @{ error = "Gemini returned no answer ($why)." }
        }
        foreach ($part in @($cand.content.parts)) {
            if ($null -eq $part -or -not ($part.text -is [string])) { continue }
            if ($part.thought) { $thinking += $part.text } else { $outText += $part.text }
        }
        $um = $data.usageMetadata
        $inTok = if ($um -and $um.promptTokenCount) { [int]$um.promptTokenCount } else { 0 }
        $outTok = 0
        if ($um -and $um.candidatesTokenCount) { $outTok += [int]$um.candidatesTokenCount }
        if ($um -and $um.thoughtsTokenCount) { $outTok += [int]$um.thoughtsTokenCount }
        $stop = if ($cand.finishReason -eq 'MAX_TOKENS') { 'max_tokens' } else { ([string]$cand.finishReason).ToLower() }
        $modelOut = if ($data.modelVersion) { $data.modelVersion } else { $model }
    } else {
        foreach ($b in @($data.content)) {
            if ($b.type -eq 'text') { $outText += $b.text }
            elseif ($b.type -eq 'thinking' -and $b.thinking) { $thinking += $b.thinking }
        }
        $inTok = if ($data.usage -and $data.usage.input_tokens) { [int]$data.usage.input_tokens } else { 0 }
        $outTok = if ($data.usage -and $data.usage.output_tokens) { [int]$data.usage.output_tokens } else { 0 }
        $stop = $data.stop_reason
        $modelOut = if ($data.model) { $data.model } else { $model }
    }
    $usage = [ordered]@{ input_tokens = $inTok; output_tokens = $outTok }
    $shownEffort = if ($adaptive) { $effort } else { $null }
    $mode = if ($adaptive) { $effort } else { 'budget' }
    Write-Host ("[coach] {0} ({1}) {2:N1} s, {3} in / {4} out tokens, stop={5}" -f $modelOut, $mode, $sw.Elapsed.TotalSeconds, $inTok, $outTok, $stop)
    return Send-Json $response 200 ([ordered]@{ text = $outText; thinking = ($thinking -join "`n`n"); provider = $provider; model = $modelOut; effort = $shownEffort; stopReason = $stop; usage = $usage })
}

# --------------------------------------------------------------------- Ask --
# The rider's data goes in a second system block marked for prompt caching (identical on every follow-up).
function New-ClaudeAskMessage($messages, [string]$context, [string]$model, [string]$effort, [bool]$fallback) {
    $ctx = if ($context -ne '') { $context } else { '(no data for this period)' }
    $list = @()
    foreach ($m in $messages) { $list += [ordered]@{ role = $m.role; content = $m.content } }
    $req = [ordered]@{
        model      = $model
        max_tokens = 16000
        system     = @(
            [ordered]@{ type = 'text'; text = $askSystemPrompt },
            [ordered]@{ type = 'text'; text = "TRAINING DATA`n$ctx"; cache_control = @{ type = 'ephemeral' } }
        )
        messages   = $list
    }
    if ($models[$model].adaptive) {
        $req.thinking = [ordered]@{ type = 'adaptive'; display = 'summarized' }
        $req.output_config = @{ effort = $effort }
    } else {
        $req.thinking = [ordered]@{ type = 'enabled'; budget_tokens = 4000 }
    }
    if ($fallback -and $model -eq 'claude-opus-5-5') { $req.fallbacks = 'default' }
    $msg = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, "$apiBase/v1/messages")
    $msg.Headers.Add('x-api-key', $apiKey)
    $msg.Headers.Add('anthropic-version', '2023-06-01')
    if ($req.Contains('fallbacks')) { $msg.Headers.Add('anthropic-beta', $fallbackBeta) }
    $msg.Content = New-Object System.Net.Http.StringContent(($req | ConvertTo-Json -Depth 10 -Compress), $utf8, 'application/json')
    return $msg
}

# Gemini answers Ask in plain text (no JSON response type); assistant turns are role "model".
function New-GeminiAskMessage($messages, [string]$context, [string]$model, [string]$effort) {
    $ctx = if ($context -ne '') { $context } else { '(no data for this period)' }
    $contents = @()
    foreach ($m in $messages) {
        $role = if ($m.role -eq 'assistant') { 'model' } else { 'user' }
        $contents += [ordered]@{ role = $role; parts = @(@{ text = $m.content }) }
    }
    $req = [ordered]@{
        systemInstruction = @{ parts = @(@{ text = $askSystemPrompt }, @{ text = "TRAINING DATA`n$ctx" }) }
        contents          = $contents
        generationConfig  = [ordered]@{
            maxOutputTokens = 16000
            thinkingConfig  = [ordered]@{ thinkingLevel = $effort; includeThoughts = $true }
        }
    }
    $url = "$geminiBase/v1beta/models/$([System.Uri]::EscapeDataString($model)):generateContent"
    $msg = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, $url)
    $msg.Headers.Add('x-goog-api-key', $geminiKey)
    $msg.Content = New-Object System.Net.Http.StringContent(($req | ConvertTo-Json -Depth 10 -Compress), $utf8, 'application/json')
    return $msg
}

# 1-40 messages, user / assistant alternating, starting and ending with the rider; each 1-20000 characters;
# the data block at most 150000 characters. Returns @{ messages; context } or @{ error }.
function Test-AskInput($payload) {
    $raw = @($payload.messages)
    if ($null -eq $payload.messages -or $raw.Count -lt 1 -or $raw.Count -gt $askMaxMessages) { return @{ error = "Send 1-$askMaxMessages messages." } }
    $list = @()
    for ($i = 0; $i -lt $raw.Count; $i++) {
        $m = $raw[$i]
        $role = $null
        if ($m -and $m.role -eq 'assistant') { $role = 'assistant' } elseif ($m -and $m.role -eq 'user') { $role = 'user' }
        $content = if ($m -and $m.content -is [string]) { $m.content.Trim() } else { '' }
        if (-not $role -or $content -eq '' -or $content.Length -gt $askMaxMessageChars) { return @{ error = "Each message needs a role (user or assistant) and 1-$askMaxMessageChars characters." } }
        $expected = if ($i % 2 -eq 0) { 'user' } else { 'assistant' }
        if ($role -ne $expected) { return @{ error = 'Messages must alternate, starting with the rider.' } }
        $list += [pscustomobject]@{ role = $role; content = $content }
    }
    if ($list[$list.Count - 1].role -ne 'user') { return @{ error = "The last message must be the rider's question." } }
    $context = if ($payload.context -is [string]) { $payload.context } else { '' }
    if ($context.Length -gt $askMaxContextChars) { return @{ error = "The training data is too long (over $askMaxContextChars characters): pick a shorter period." } }
    return @{ messages = $list; context = $context }
}

# Sends one prepared request; returns @{ code; data; ok } or @{ failed; timedOut; message }.
function Send-AiRequest($msg) {
    try {
        $upstream = $http.SendAsync($msg).GetAwaiter().GetResult()
        $text = $utf8.GetString($upstream.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult())
    } catch {
        $inner = $_.Exception
        while ($inner.InnerException) { $inner = $inner.InnerException }
        $timedOut = ($inner -is [System.Threading.Tasks.TaskCanceledException]) -or ($inner -is [System.TimeoutException])
        return @{ failed = $true; timedOut = $timedOut; message = $inner.Message }
    } finally { $msg.Dispose() }
    $data = $null
    try { $data = $text | ConvertFrom-Json } catch { }
    return @{ failed = $false; ok = $upstream.IsSuccessStatusCode; code = [int]$upstream.StatusCode; data = $data }
}

function Invoke-Ask($request, $response) {
    if (-not (Test-LocalRequest $request)) { return Send-Json $response 403 @{ error = 'Requests are only accepted from the app on localhost.' } }
    if ($request.ContentType -notmatch '^application/json\b') { return Send-Json $response 415 @{ error = 'Content-Type must be application/json.' } }
    if ($request.ContentLength64 -gt $maxBodyBytes) { return Send-Json $response 413 @{ error = 'Request too large' } }
    $reader = New-Object System.IO.StreamReader($request.InputStream, $utf8)
    $bodyText = $reader.ReadToEnd(); $reader.Close()
    if ($utf8.GetByteCount($bodyText) -gt $maxBodyBytes) { return Send-Json $response 413 @{ error = 'Request too large' } }
    try { $payload = $bodyText | ConvertFrom-Json } catch { return Send-Json $response 400 @{ error = 'Invalid JSON.' } }
    if ($null -eq $payload) { return Send-Json $response 400 @{ error = 'Invalid JSON.' } }
    $v = Test-AskInput $payload
    if ($v.error) { return Send-Json $response 400 @{ error = $v.error } }
    # The model decides the provider; without a (known) model, use the requested or default provider's default model.
    $knownModel = ($payload.model -is [string]) -and $models.Contains($payload.model)
    if ($knownModel) { $model = $payload.model; $provider = $models[$model].provider }
    else {
        $provider = if ($payload.provider -is [string] -and $providers.Contains($payload.provider)) { $payload.provider } else { $defaultProvider }
        $model = $defaultModels[$provider]
    }
    $effort = if ($payload.effort -is [string] -and $efforts -contains $payload.effort) { $payload.effort } else { $defaultEffort }
    $adaptive = $models[$model].adaptive
    $pLabel = $providers[$provider].label
    if ($keys[$provider] -eq '') { return Send-Json $response 503 @{ error = "No $pLabel API key. Add $($providers[$provider].keyName) to the .env file and restart Launch-Apex-Velo.bat." } }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    if ($provider -eq 'gemini') { $r = Send-AiRequest (New-GeminiAskMessage $v.messages $v.context $model $effort) }
    else {
        $r = Send-AiRequest (New-ClaudeAskMessage $v.messages $v.context $model $effort $true)
        # An account or gateway that does not accept the fallback option gets the same question without it.
        $errText = if (-not $r.failed -and $r.data -and $r.data.error -and $r.data.error.message) { [string]$r.data.error.message } else { '' }
        if (-not $r.failed -and $r.code -eq 400 -and $errText -match 'fallback') { $r = Send-AiRequest (New-ClaudeAskMessage $v.messages $v.context $model $effort $false) }
    }
    if ($r.failed) {
        Write-Host "[ask] $model $(if ($r.timedOut) { 'timed out' } else { 'request failed: ' + $r.message })" -ForegroundColor Yellow
        if ($r.timedOut) { return Send-Json $response 504 @{ error = "$pLabel did not answer in time." } }
        return Send-Json $response 502 @{ error = "Could not reach the $pLabel API ($($r.message))." }
    }
    $data = $r.data
    if (-not $r.ok) {
        $err = if ($data -and $data.error -and $data.error.message) { $data.error.message } else { "HTTP $($r.code)" }
        Write-Host "[ask] $model failed: $($r.code) $err" -ForegroundColor Yellow
        return Send-Json $response 502 @{ error = "$pLabel API error $($r.code): $err"; upstreamStatus = $r.code }
    }

    $outText = ''; $cacheRead = 0
    if ($provider -eq 'gemini') {
        $cand = if ($data -and $data.candidates) { @($data.candidates)[0] } else { $null }
        if (-not $cand) {
            $why = if ($data -and $data.promptFeedback -and $data.promptFeedback.blockReason) { $data.promptFeedback.blockReason } else { 'no answer' }
            Write-Host "[ask] $model returned no candidates ($why)" -ForegroundColor Yellow
            return Send-Json $response 502 @{ error = "Gemini returned no answer ($why)." }
        }
        foreach ($part in @($cand.content.parts)) {
            if ($null -eq $part -or -not ($part.text -is [string]) -or $part.thought) { continue }
            $outText += $part.text
        }
        $um = $data.usageMetadata
        $inTok = if ($um -and $um.promptTokenCount) { [int]$um.promptTokenCount } else { 0 }
        $outTok = 0
        if ($um -and $um.candidatesTokenCount) { $outTok += [int]$um.candidatesTokenCount }
        if ($um -and $um.thoughtsTokenCount) { $outTok += [int]$um.thoughtsTokenCount }
        $stop = if ($cand.finishReason -eq 'MAX_TOKENS') { 'max_tokens' } else { ([string]$cand.finishReason).ToLower() }
        $modelOut = if ($data.modelVersion) { $data.modelVersion } else { $model }
    } else {
        foreach ($b in @($data.content)) { if ($b -and $b.type -eq 'text') { $outText += $b.text } }
        $inTok = if ($data.usage -and $data.usage.input_tokens) { [int]$data.usage.input_tokens } else { 0 }
        $outTok = if ($data.usage -and $data.usage.output_tokens) { [int]$data.usage.output_tokens } else { 0 }
        $cacheRead = if ($data.usage -and $data.usage.cache_read_input_tokens) { [int]$data.usage.cache_read_input_tokens } else { 0 }
        $stop = $data.stop_reason
        $modelOut = if ($data.model) { $data.model } else { $model }
    }
    $refused = ($stop -eq 'refusal') -and ($outText.Trim() -eq '')
    if ($refused) { $outText = "I can't answer that one. Try asking it another way, or about a specific part of your training." }
    $usage = [ordered]@{ input_tokens = $inTok; output_tokens = $outTok; cache_read_input_tokens = $cacheRead }
    $shownEffort = if ($adaptive) { $effort } else { $null }
    $mode = if ($adaptive) { $effort } else { 'budget' }
    Write-Host ("[ask] {0} ({1}) {2:N1} s, {3} in ({4} cached) / {5} out tokens, stop={6}" -f $modelOut, $mode, $sw.Elapsed.TotalSeconds, $inTok, $cacheRead, $outTok, $stop)
    return Send-Json $response 200 ([ordered]@{ text = $outText; refused = $refused; provider = $provider; model = $modelOut; effort = $shownEffort; stopReason = $stop; usage = $usage })
}

# ------------------------------------------------------------------ Strava --
# Personal Strava API application: STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET in .env.
# Tokens are kept in .strava-tokens.json next to this script (a dot-file, never served).
$stravaClientId = (Get-Setting 'STRAVA_CLIENT_ID' '').Trim()
$stravaClientSecret = (Get-Setting 'STRAVA_CLIENT_SECRET' '').Trim()
$stravaBase = (Get-Setting 'APEX_STRAVA_BASE_URL' 'https://www.strava.com').TrimEnd('/')
$stravaTokenFile = Join-Path $root '.strava-tokens.json'
$script:stravaStates = @{}
$maxUploadBytes = 12MB

function Read-StravaTokens {
    if (-not (Test-Path $stravaTokenFile -PathType Leaf)) { return $null }
    try { return ([System.IO.File]::ReadAllText($stravaTokenFile) | ConvertFrom-Json) } catch { return $null }
}
function Save-StravaTokens($data) {
    $obj = [ordered]@{
        access_token  = [string]$data.access_token
        refresh_token = [string]$data.refresh_token
        expires_at    = [long]$data.expires_at
        scope         = [string]$data.scope
        athlete       = [ordered]@{ id = $data.athlete.id; firstname = [string]$data.athlete.firstname; lastname = [string]$data.athlete.lastname }
    }
    [System.IO.File]::WriteAllText($stravaTokenFile, ($obj | ConvertTo-Json -Depth 5), $utf8)
}
function Invoke-StravaForm([string]$url, [hashtable]$fields) {
    $dict = New-Object 'System.Collections.Generic.Dictionary[string,string]'
    foreach ($k in $fields.Keys) { $dict[$k] = [string]$fields[$k] }
    $content = New-Object System.Net.Http.FormUrlEncodedContent($dict)
    $resp = $http.PostAsync($url, $content).GetAwaiter().GetResult()
    $text = $utf8.GetString($resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult())
    $data = $null; try { $data = $text | ConvertFrom-Json } catch { }
    return @{ ok = $resp.IsSuccessStatusCode; status = [int]$resp.StatusCode; data = $data; text = $text }
}
# Returns a valid access token (refreshing it when it expires within 2 minutes) or $null.
function Get-StravaAccessToken {
    $t = Read-StravaTokens
    if (-not $t -or -not $t.refresh_token) { return $null }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    if ($t.access_token -and [long]$t.expires_at -gt ($now + 120)) { return [string]$t.access_token }
    $r = Invoke-StravaForm "$stravaBase/oauth/token" @{ client_id = $stravaClientId; client_secret = $stravaClientSecret; grant_type = 'refresh_token'; refresh_token = [string]$t.refresh_token }
    if (-not $r.ok) { Write-Host "[strava] token refresh failed: $($r.status)" -ForegroundColor Yellow; return $null }
    $d = $r.data
    Save-StravaTokens ([pscustomobject]@{ access_token = $d.access_token; refresh_token = $d.refresh_token; expires_at = $d.expires_at; scope = $t.scope; athlete = $t.athlete })
    return [string]$d.access_token
}
function Get-StravaStatus {
    $t = Read-StravaTokens
    $name = $null
    if ($t -and $t.athlete) { $name = ("$($t.athlete.firstname) $($t.athlete.lastname)").Trim() }
    return [ordered]@{
        configured = ($stravaClientId -ne '' -and $stravaClientSecret -ne '')
        connected  = [bool]($t -and $t.refresh_token)
        athlete    = $name
        canUpload  = [bool]($t -and ([string]$t.scope) -match 'activity:write')
        canCheck   = [bool]($t -and ([string]$t.scope) -match 'activity:read')
        canSync    = [bool]($t -and ([string]$t.scope) -match 'activity:read_all')
    }
}
function Send-Html($response, [int]$status, [string]$title, [string]$body) {
    $html = "<!doctype html><html><head><meta charset='utf-8'><title>$title</title><style>body{font-family:system-ui,sans-serif;background:#090d16;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:520px;padding:32px;border:1px solid #1e293b;border-radius:16px;background:#0f172a}h1{font-size:20px}a{color:#fc4c02}</style></head><body><main>$body</main></body></html>"
    Send-Bytes $response $status $utf8.GetBytes($html) 'text/html; charset=utf-8'
}
function Get-QueryValue($request, [string]$name) {
    $v = $request.QueryString[$name]
    if ($null -eq $v) { return '' } else { return [string]$v }
}

function Invoke-StravaConnect($request, $response) {
    if (-not (Test-LocalRequest $request)) { return Send-Text $response 403 'Forbidden' }
    if ($stravaClientId -eq '' -or $stravaClientSecret -eq '') {
        return Send-Html $response 400 'Strava not set up' "<h1>Strava is not set up yet</h1><p>Add <code>STRAVA_CLIENT_ID</code> and <code>STRAVA_CLIENT_SECRET</code> to the <code>.env</code> file, restart Launch-Apex-Velo.bat, then try again.</p>"
    }
    $state = [guid]::NewGuid().ToString('N')
    $script:stravaStates[$state] = [DateTime]::UtcNow
    $redirect = "http://localhost:$port/api/strava/callback"
    $url = "$stravaBase/oauth/authorize?client_id=$([uri]::EscapeDataString($stravaClientId))&response_type=code&redirect_uri=$([uri]::EscapeDataString($redirect))&approval_prompt=auto&scope=$([uri]::EscapeDataString('read,activity:read_all,activity:write'))&state=$state"
    $response.StatusCode = 302
    $response.RedirectLocation = $url
    $response.Close()
}

function Invoke-StravaCallback($request, $response) {
    $state = Get-QueryValue $request 'state'
    $code = Get-QueryValue $request 'code'
    $err = Get-QueryValue $request 'error'
    $scope = Get-QueryValue $request 'scope'
    $fresh = $script:stravaStates.ContainsKey($state) -and ([DateTime]::UtcNow - $script:stravaStates[$state]).TotalMinutes -lt 15
    if ($state) { $script:stravaStates.Remove($state) }
    if (-not $fresh) { return Send-Html $response 400 'Strava' "<h1>Link expired</h1><p>Start again from the app with <b>Connect Strava</b>.</p>" }
    if ($err -or -not $code) { return Send-Html $response 400 'Strava' "<h1>Strava access was not granted</h1><p>Nothing was changed. You can try again from the app.</p><p><a href='/index.html'>Back to Apex Velo Lab</a></p>" }
    if ($scope -notmatch 'activity:write') { return Send-Html $response 400 'Strava' "<h1>Upload permission missing</h1><p>Please tick <b>Upload your activities</b> on the Strava screen, then connect again.</p><p><a href='/api/strava/connect'>Connect again</a></p>" }
    $r = Invoke-StravaForm "$stravaBase/oauth/token" @{ client_id = $stravaClientId; client_secret = $stravaClientSecret; code = $code; grant_type = 'authorization_code' }
    if (-not $r.ok) {
        Write-Host "[strava] token exchange failed: $($r.status) $($r.text)" -ForegroundColor Yellow
        return Send-Html $response 502 'Strava' "<h1>Could not finish connecting</h1><p>Strava answered $($r.status). Check STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET in .env.</p>"
    }
    $d = $r.data
    Save-StravaTokens ([pscustomobject]@{ access_token = $d.access_token; refresh_token = $d.refresh_token; expires_at = $d.expires_at; scope = $scope; athlete = $d.athlete })
    $who = [System.Net.WebUtility]::HtmlEncode(("$($d.athlete.firstname) $($d.athlete.lastname)").Trim())
    Write-Host "[strava] connected as $who" -ForegroundColor Green
    Send-Html $response 200 'Strava connected' "<h1>Connected to Strava</h1><p>Signed in as <b>$who</b>. You can close this tab and go back to Apex Velo Lab.</p><script>try{window.opener&&window.opener.postMessage({apexStrava:'connected'},location.origin)}catch(e){};setTimeout(function(){window.close()},1500)</script>"
}

function Invoke-StravaDisconnect($request, $response) {
    if (-not (Test-LocalRequest $request)) { return Send-Json $response 403 @{ error = 'Forbidden' } }
    $token = Get-StravaAccessToken
    if ($token) { try { [void](Invoke-StravaForm "$stravaBase/oauth/deauthorize" @{ access_token = $token }) } catch { } }
    if (Test-Path $stravaTokenFile) { Remove-Item $stravaTokenFile -Force -ErrorAction SilentlyContinue }
    Send-Json $response 200 (Get-StravaStatus)
}

# Maps Strava's upload record to what the app shows. A duplicate counts as "already on Strava".
function Convert-StravaUpload($d) {
    $errText = [string]$d.error
    $activity = $d.activity_id
    $dup = $null
    if ($errText -match 'duplicate of[^0-9]*?(?:activities/)?(\d+)') { $dup = $Matches[1] }
    $state = 'processing'
    if ($activity) { $state = 'sent' }
    elseif ($dup) { $state = 'duplicate'; $activity = $dup }
    elseif ($errText) { $state = 'failed' }
    return [ordered]@{ uploadId = [string]$d.id_str; state = $state; activityId = $(if ($activity) { [string]$activity } else { $null }); status = [string]$d.status; error = $(if ($errText) { $errText } else { $null }) }
}

function Invoke-StravaUpload($request, $response) {
    if (-not (Test-LocalRequest $request)) { return Send-Json $response 403 @{ error = 'Requests are only accepted from the app on localhost.' } }
    if ($request.ContentType -notmatch '^application/json\b') { return Send-Json $response 415 @{ error = 'Content-Type must be application/json.' } }
    if ($request.ContentLength64 -gt $maxUploadBytes) { return Send-Json $response 413 @{ error = 'Ride file too large' } }
    $token = Get-StravaAccessToken
    if (-not $token) { return Send-Json $response 401 @{ error = 'Strava is not connected (or access was revoked). Connect Strava and try again.'; needsConnect = $true } }
    $reader = New-Object System.IO.StreamReader($request.InputStream, $utf8)
    $bodyText = $reader.ReadToEnd(); $reader.Close()
    try { $payload = $bodyText | ConvertFrom-Json } catch { return Send-Json $response 400 @{ error = 'Invalid JSON.' } }
    try { $fit = [Convert]::FromBase64String([string]$payload.fitBase64) } catch { return Send-Json $response 400 @{ error = 'Invalid ride file.' } }
    if ($fit.Length -lt 14) { return Send-Json $response 400 @{ error = 'Ride file is empty.' } }

    $mp = New-Object System.Net.Http.MultipartFormDataContent
    $fileContent = New-Object System.Net.Http.ByteArrayContent(, $fit)
    $fileContent.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue('application/octet-stream')
    $mp.Add($fileContent, 'file', 'apex-velo-ride.fit')
    $parts = [ordered]@{ data_type = 'fit'; name = [string]$payload.name; description = [string]$payload.description; trainer = '1'; commute = '0'; external_id = [string]$payload.externalId }
    foreach ($k in $parts.Keys) { if ($parts[$k] -ne '') { $mp.Add((New-Object System.Net.Http.StringContent($parts[$k], $utf8)), $k) } }
    $msg = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, "$stravaBase/api/v3/uploads")
    $msg.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $token)
    $msg.Content = $mp
    try {
        $resp = $http.SendAsync($msg).GetAwaiter().GetResult()
        $text = $utf8.GetString($resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult())
    } catch {
        return Send-Json $response 502 @{ error = "Could not reach Strava ($($_.Exception.Message))." }
    } finally { $msg.Dispose() }
    $d = $null; try { $d = $text | ConvertFrom-Json } catch { }
    $code = [int]$resp.StatusCode
    if ($code -eq 401) { return Send-Json $response 401 @{ error = 'Strava rejected the sign-in. Connect Strava again.'; needsConnect = $true } }
    if ($code -eq 429) { return Send-Json $response 429 @{ error = 'Strava rate limit reached - try again in 15 minutes.' } }
    if (-not $resp.IsSuccessStatusCode -or -not $d) {
        $m = if ($d -and $d.message) { $d.message } else { "HTTP $code" }
        Write-Host "[strava] upload failed: $code $text" -ForegroundColor Yellow
        return Send-Json $response 502 @{ error = "Strava upload failed: $m" }
    }
    $out = Convert-StravaUpload $d
    Write-Host "[strava] upload $($out.uploadId): $($out.state)"
    Send-Json $response 200 $out
}

# Lists your Strava activities in a time window (unix seconds), newest first, compact fields only.
function Invoke-StravaActivities($request, $response) {
    if (-not (Test-LocalRequest $request)) { return Send-Json $response 403 @{ error = 'Forbidden' } }
    $after = Get-QueryValue $request 'after'; $before = Get-QueryValue $request 'before'
    if ($after -notmatch '^\d+$' -or $before -notmatch '^\d+$') { return Send-Json $response 400 @{ error = 'after and before (unix seconds) are required' } }
    $token = Get-StravaAccessToken
    if (-not $token) { return Send-Json $response 401 @{ error = 'Strava is not connected.'; needsConnect = $true } }
    $list = New-Object System.Collections.ArrayList
    for ($page = 1; $page -le 10; $page++) {
        $msg = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, "$stravaBase/api/v3/athlete/activities?after=$after&before=$before&per_page=200&page=$page")
        $msg.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $token)
        try {
            $resp = $http.SendAsync($msg).GetAwaiter().GetResult()
            $text = $utf8.GetString($resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult())
        } catch { return Send-Json $response 502 @{ error = "Could not reach Strava ($($_.Exception.Message))." } } finally { $msg.Dispose() }
        $code = [int]$resp.StatusCode
        if ($code -eq 401) { return Send-Json $response 401 @{ error = 'Strava needs permission to read your activities. Connect Strava again.'; needsConnect = $true } }
        if ($code -eq 429) { return Send-Json $response 429 @{ error = 'Strava rate limit reached - try again in 15 minutes.' } }
        if (-not $resp.IsSuccessStatusCode) { return Send-Json $response 502 @{ error = "Strava activity list failed (HTTP $code)." } }
        # Windows PowerShell 5.1 returns a JSON array as ONE object: enumerate it explicitly.
        $parsed = $text | ConvertFrom-Json
        $items = @(foreach ($x in $parsed) { $x })
        foreach ($a in $items) {
            if ($null -eq $a -or $null -eq $a.id) { continue }
            # PowerShell 7 turns ISO dates into DateTime objects; always hand the browser an ISO UTC string.
            $st = $a.start_date
            if ($st -is [datetime]) { $st = $st.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ', [System.Globalization.CultureInfo]::InvariantCulture) } else { $st = [string]$st }
            [void]$list.Add([ordered]@{ id = [string]$a.id; name = [string]$a.name; start = $st; elapsed = [int]$a.elapsed_time; moving = [int]$a.moving_time; sport = [string]$a.sport_type; trainer = [bool]$a.trainer })
        }
        if ($items.Count -lt 200) { break }
    }
    Send-Json $response 200 @{ activities = @($list) }
}

# --------------------------------------------------------- Strava sync (READ ONLY) --
# "Sync from Strava" only ever reads: GET /api/v3/athlete/activities, GET /api/v3/activities/{id}
# and GET /api/v3/activities/{id}/streams.
# Nothing is uploaded, edited or deleted on Strava by this path. (Same behaviour as server.js.)
$syncMaxPages = 10        # 10 x 200 activities
$syncMaxDetailIds = 10    # activities/{id} per request; the app batches and shows progress
$syncStreamKeys = 'time,watts,heartrate,cadence,velocity_smooth,distance'
$syncFields = @('name', 'type', 'sport_type', 'start_date', 'start_date_local', 'timezone', 'moving_time', 'elapsed_time', 'distance',
    'calories', 'average_watts', 'weighted_average_watts', 'max_watts', 'kilojoules', 'device_watts', 'average_heartrate', 'max_heartrate',
    'average_cadence', 'suffer_score', 'trainer', 'description')

# Strava's read rate-limit usage from the response headers.
function Get-StravaRate($resp) {
    $pick = {
        param([string]$a, [string]$b)
        $vals = $null
        foreach ($n in @($a, $b)) { if ($resp.Headers.TryGetValues($n, [ref]$vals)) { return (@($vals)[0] -split ',') } }
        return @()
    }
    $used = & $pick 'X-ReadRateLimit-Usage' 'X-RateLimit-Usage'
    $lim = & $pick 'X-ReadRateLimit-Limit' 'X-RateLimit-Limit'
    $n = { param($arr, [int]$i, [int]$d) if ($arr.Count -gt $i -and $arr[$i] -match '^\s*\d+\s*$') { return [int]$arr[$i] } else { return $d } }
    return [ordered]@{ used15 = (& $n $used 0 0); usedDay = (& $n $used 1 0); limit15 = (& $n $lim 0 100); limitDay = (& $n $lim 1 1000) }
}
# ISO UTC string for a Strava date (PowerShell 7 turns ISO strings into DateTime objects).
function ConvertTo-IsoUtc($v) {
    if ($null -eq $v) { return '' }
    if ($v -is [datetime]) { return $v.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ', [System.Globalization.CultureInfo]::InvariantCulture) }
    $d = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse([string]$v, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AssumeUniversal, [ref]$d)) {
        return $d.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ', [System.Globalization.CultureInfo]::InvariantCulture)
    }
    return ''
}
# The compact activity the app works with. detailed = fetched from activities/{id} (has description/calories).
function ConvertTo-SlimActivity($a, [bool]$detailed) {
    $o = [ordered]@{ id = [string]$a.id; detailed = $detailed }
    $names = @($a.PSObject.Properties.Name)
    foreach ($k in $syncFields) {
        if ($names -contains $k -and $null -ne $a.$k) { $o[$k] = $a.$k }
    }
    $o['start_date'] = ConvertTo-IsoUtc $a.start_date
    if ($null -ne $a.start_date_local) { $o['start_date_local'] = ConvertTo-IsoUtc $a.start_date_local }
    if (-not $detailed) { $o.Remove('description'); $o.Remove('calories') }
    $o['trainer'] = [bool]$a.trainer
    return $o
}
# One GET to the Strava API. The sync path has no other way to reach Strava.
function Invoke-StravaGet([string]$pathAndQuery, [string]$token) {
    $msg = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, "$stravaBase/api/v3/$pathAndQuery")
    $msg.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $token)
    try {
        $resp = $http.SendAsync($msg).GetAwaiter().GetResult()
        $text = $utf8.GetString($resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult())
    } finally { $msg.Dispose() }
    $data = $null; try { $data = $text | ConvertFrom-Json } catch { }
    return @{ status = [int]$resp.StatusCode; ok = $resp.IsSuccessStatusCode; data = $data; rate = (Get-StravaRate $resp) }
}

function Invoke-StravaSync($request, $response) {
    if ($request.HttpMethod -ne 'GET') { return Send-Json $response 405 @{ error = 'Method not allowed' } }
    if (-not (Test-LocalRequest $request)) { return Send-Json $response 403 @{ error = 'Forbidden' } }
    $t = Read-StravaTokens
    if (-not $t -or -not $t.refresh_token) { return Send-Json $response 401 @{ error = 'Strava is not connected. Connect Strava first.'; needsConnect = $true } }
    if (([string]$t.scope) -notmatch 'activity:read_all') {
        return Send-Json $response 403 @{ error = 'Strava sync needs permission to read all your activities. Reconnect Strava (Disconnect, then Connect Strava) and allow access to your activities.'; needsReconnect = $true }
    }
    $token = Get-StravaAccessToken
    if (-not $token) { return Send-Json $response 401 @{ error = 'Strava sign-in expired or was revoked. Reconnect Strava.'; needsConnect = $true } }

    # Second-by-second data of ONE activity, passed through as Strava sends it (the app converts it).
    $sid = $request.QueryString['streams']
    if ($null -ne $sid) {
        if ($sid -notmatch '^\d+$') { return Send-Json $response 400 @{ error = 'streams must be one activity id' } }
        $msg = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, "$stravaBase/api/v3/activities/$sid/streams?keys=$syncStreamKeys&key_by_type=true")
        $msg.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $token)
        try {
            $resp = $http.SendAsync($msg).GetAwaiter().GetResult()
            $text = $utf8.GetString($resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult())
        } catch { return Send-Json $response 502 @{ error = "Could not reach Strava ($($_.Exception.Message))." } } finally { $msg.Dispose() }
        $rate = Get-StravaRate $resp
        $code = [int]$resp.StatusCode
        if ($code -eq 401) { return Send-Json $response 401 @{ error = 'Strava rejected the sign-in. Reconnect Strava.'; needsConnect = $true } }
        if ($code -eq 429) { return Send-Json $response 200 ([ordered]@{ id = $sid; rateLimited = $true; rate = $rate }) }
        if ($code -eq 404) { return Send-Json $response 200 ([ordered]@{ id = $sid; missing = $true; rate = $rate }) }
        if (-not $resp.IsSuccessStatusCode) { return Send-Json $response 502 @{ error = "Strava streams for $sid failed (HTTP $code)." } }
        $body = $text.Trim()
        if (-not $body.StartsWith('{')) { $body = '{}' }
        return Send-RawJson $response 200 ('{"id":"' + $sid + '","streams":' + $body + ',"rate":' + ($rate | ConvertTo-Json -Compress) + '}')
    }

    $ids = $request.QueryString['ids']
    if ($null -ne $ids) {
        if ($ids -notmatch '^\d+(,\d+)*$') { return Send-Json $response 400 @{ error = 'ids must be a comma-separated list of activity ids' } }
        $list = @($ids.Split(',') | Select-Object -Unique)
        if ($list.Count -gt $syncMaxDetailIds) { return Send-Json $response 400 @{ error = "At most $syncMaxDetailIds ids per request" } }
        $out = New-Object System.Collections.ArrayList
        $missing = New-Object System.Collections.ArrayList
        $rate = $null
        foreach ($id in $list) {
            try { $r = Invoke-StravaGet "activities/$id" $token }
            catch { return Send-Json $response 502 @{ error = "Could not reach Strava ($($_.Exception.Message))."; activities = @($out); missing = @($missing) } }
            $rate = $r.rate
            if ($r.status -eq 401) { return Send-Json $response 401 @{ error = 'Strava rejected the sign-in. Reconnect Strava.'; needsConnect = $true } }
            if ($r.status -eq 429) { return Send-Json $response 200 ([ordered]@{ activities = @($out); missing = @($missing); rateLimited = $true; rate = $rate }) }
            if ($r.status -eq 404) { [void]$missing.Add([string]$id); continue }
            if (-not $r.ok -or -not $r.data) { return Send-Json $response 502 @{ error = "Strava activity $id failed (HTTP $($r.status))."; activities = @($out); missing = @($missing) } }
            [void]$out.Add((ConvertTo-SlimActivity $r.data $true))
        }
        return Send-Json $response 200 ([ordered]@{ activities = @($out); missing = @($missing); rateLimited = $false; rate = $rate })
    }

    $inv = [System.Globalization.CultureInfo]::InvariantCulture
    $sty = [System.Globalization.DateTimeStyles]::AssumeUniversal
    $a0 = [DateTimeOffset]::MinValue; $b0 = [DateTimeOffset]::MinValue
    $okA = [DateTimeOffset]::TryParse([string]$request.QueryString['after'], $inv, $sty, [ref]$a0)
    $okB = [DateTimeOffset]::TryParse([string]$request.QueryString['before'], $inv, $sty, [ref]$b0)
    if (-not $okA -or -not $okB -or $b0 -le $a0) { return Send-Json $response 400 @{ error = 'after and before must be ISO dates, with after before before' } }
    $after = [long][Math]::Floor($a0.ToUnixTimeMilliseconds() / 1000)
    $before = [long][Math]::Ceiling($b0.ToUnixTimeMilliseconds() / 1000)
    $list = New-Object System.Collections.ArrayList
    $rate = $null; $pages = 0
    for ($page = 1; $page -le $syncMaxPages; $page++) {
        try { $r = Invoke-StravaGet "athlete/activities?after=$after&before=$before&per_page=200&page=$page" $token }
        catch { return Send-Json $response 502 @{ error = "Could not reach Strava ($($_.Exception.Message))." } }
        $rate = $r.rate; $pages = $page
        if ($r.status -eq 401) { return Send-Json $response 401 @{ error = 'Strava needs permission to read your activities. Reconnect Strava.'; needsConnect = $true } }
        if ($r.status -eq 429) { return Send-Json $response 429 @{ error = 'Strava rate limit reached - try again in 15 minutes.'; rate = $rate } }
        if (-not $r.ok -or $null -eq $r.data) { return Send-Json $response 502 @{ error = "Strava activity list failed (HTTP $($r.status))." } }
        # Windows PowerShell 5.1 returns a JSON array as ONE object: enumerate it explicitly.
        $items = @(foreach ($x in $r.data) { $x })
        foreach ($a in $items) { if ($null -ne $a -and $null -ne $a.id) { [void]$list.Add((ConvertTo-SlimActivity $a $false)) } }
        if ($items.Count -lt 200) { break }
    }
    Write-Host "[strava] sync list $($a0.UtcDateTime.ToString('yyyy-MM-dd'))..$($b0.UtcDateTime.ToString('yyyy-MM-dd')): $($list.Count) activities ($pages page(s))"
    Send-Json $response 200 ([ordered]@{
        activities = @($list)
        after = $a0.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', $inv)
        before = $b0.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', $inv)
        pages = $pages
        rate = $rate
    })
}

function Invoke-StravaUploadStatus($request, $response, [string]$uploadId) {
    if (-not (Test-LocalRequest $request)) { return Send-Json $response 403 @{ error = 'Forbidden' } }
    if ($uploadId -notmatch '^\d+$') { return Send-Json $response 400 @{ error = 'Bad upload id' } }
    $token = Get-StravaAccessToken
    if (-not $token) { return Send-Json $response 401 @{ error = 'Strava is not connected.'; needsConnect = $true } }
    $msg = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, "$stravaBase/api/v3/uploads/$uploadId")
    $msg.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $token)
    try {
        $resp = $http.SendAsync($msg).GetAwaiter().GetResult()
        $text = $utf8.GetString($resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult())
    } catch {
        return Send-Json $response 502 @{ error = "Could not reach Strava ($($_.Exception.Message))." }
    } finally { $msg.Dispose() }
    $d = $null; try { $d = $text | ConvertFrom-Json } catch { }
    if (-not $resp.IsSuccessStatusCode -or -not $d) { return Send-Json $response 502 @{ error = "Strava status check failed (HTTP $([int]$resp.StatusCode))." } }
    Send-Json $response 200 (Convert-StravaUpload $d)
}

$mime = @{
    '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'; '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'
    '.ico' = 'image/x-icon'; '.woff2' = 'font/woff2'; '.tcx' = 'application/xml'; '.csv' = 'text/csv; charset=utf-8'
    '.md' = 'text/markdown; charset=utf-8'; '.webmanifest' = 'application/manifest+json'
}
function Send-StaticFile($request, $response) {
    $rel = $request.Url.AbsolutePath
    try { $rel = [System.Uri]::UnescapeDataString($rel) } catch { return Send-Text $response 400 'Bad request' }
    $rel = $rel.TrimStart('/')
    if ($rel -eq '') { $rel = 'index.html' }
    if ($rel.Contains([char]0)) { return Send-Text $response 400 'Bad request' }
    $file = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
    if ($file -ne $root -and -not $file.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { return Send-Text $response 403 'Forbidden' }
    # Never serve dot-files (.env), the servers, or helper scripts.
    $relative = $file.Substring($root.Length).TrimStart('\', '/')
    if ($relative -match '(^|[\\/])\.' -or $relative -match '^server\.js$' -or $relative -match '\.(ps1|cmd|bat|sh)$' -or $relative -match '^data[\\/](backups|health)([\\/]|$)') { return Send-Text $response 404 'Not found' }
    if (Test-Path $file -PathType Container) { $file = Join-Path $file 'index.html' }
    if (-not (Test-Path $file -PathType Leaf)) { return Send-Text $response 404 'Not found' }
    $ext = [System.IO.Path]::GetExtension($file).ToLower()
    $type = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
    $bytes = [System.IO.File]::ReadAllBytes($file)
    $response.Headers['Cache-Control'] = 'no-cache'
    $response.Headers['X-Content-Type-Options'] = 'nosniff'
    $response.StatusCode = 200
    $response.ContentType = $type
    $response.ContentLength64 = $bytes.Length
    if ($request.HttpMethod -ne 'HEAD') { $response.OutputStream.Write($bytes, 0, $bytes.Length) }
    $response.Close()
}

# ------------------------------------------------------------------ server --
# Listen on all network interfaces so the phone view works over home Wi-Fi. Windows only
# allows that after the one-time Enable-Phone-View.bat setup (a URL reservation); without
# it we fall back to this PC only, exactly as before.
$lanEnabled = $false
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://+:$port/")
try {
    $listener.Start()
    $lanEnabled = $true
} catch {
    try { $listener.Close() } catch { }
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://localhost:$port/")
}
if (-not $listener.IsListening) { try {
    $listener.Start()
} catch {
    Write-Host "Port $port is busy - is Apex Velo Lab already running? Close the other window, or set APEX_PORT in .env." -ForegroundColor Red
    Write-Host "(Your rides and settings are stored per address, so a different port starts with an empty browser history.)" -ForegroundColor Yellow
    exit 1
} }

$url = "http://localhost:$port/index.html"
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  APEX VELO LAB running at http://localhost:$port/" -ForegroundColor Green
if ($lanEnabled) {
    $ips = @()
    try {
        $ips = @([System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
            Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' } |
            ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
            Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' -and $_.Address.ToString() -match $lanHostRe } |
            ForEach-Object { $_.Address.ToString() })
    } catch { }
    foreach ($ip in $ips) { Write-Host "  Phone view (same Wi-Fi):  http://${ip}:$port/live.html" -ForegroundColor Green }
} else {
    Write-Host "  Phone view: off - run Enable-Phone-View.bat once to allow it." -ForegroundColor DarkGray
}
if ($apiKey -ne '') {
    $src = if ($keyFromEnvironment) { 'the ANTHROPIC_API_KEY environment variable' } else { '.env' }
    Write-Host "  AI Coach - Claude: ready (key from $src)" -ForegroundColor White
} else {
    Write-Host "  AI Coach - Claude: no ANTHROPIC_API_KEY in .env" -ForegroundColor DarkGray
}
if ($geminiKey -ne '') {
    $src = if ($geminiKeyFromEnvironment) { 'the GEMINI_API_KEY environment variable' } else { '.env' }
    Write-Host "  AI Coach - Gemini: ready (key from $src)" -ForegroundColor White
} else {
    Write-Host "  AI Coach - Gemini: no GEMINI_API_KEY in .env" -ForegroundColor DarkGray
}
if ($keys[$defaultProvider] -ne '') {
    $eff = if ($models[$defaultModel].adaptive) { ", $defaultEffort effort" } else { '' }
    Write-Host "  AI Coach default: $($models[$defaultModel].label)$eff (switch in the app's AI engine card)" -ForegroundColor White
} else {
    Write-Host "  AI Coach: no API key for the default provider - add one to .env. The offline engine still works." -ForegroundColor Yellow
}
if ($stravaClientId -ne '' -and $stravaClientSecret -ne '') {
    $st = Get-StravaStatus
    if ($st.connected) { Write-Host "  Strava: connected as $($st.athlete)" -ForegroundColor White } else { Write-Host "  Strava: ready to connect (use Send to Strava in a ride summary)" -ForegroundColor White }
} else {
    Write-Host "  Strava: not set up (add STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET to .env)" -ForegroundColor DarkGray
}
Write-Host "  Press Ctrl+C to stop the server when finished riding." -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Cyan

if (-not $env:APEX_NO_BROWSER) {
    $chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
    if (Test-Path $chromePath) { Start-Process $chromePath -ArgumentList $url } else { Start-Process $url }
}

try {
    while ($listener.IsListening) {
        # Poll so Ctrl+C can stop the server between requests.
        $task = $listener.GetContextAsync()
        # Short waits so parked phone-view requests are answered on time.
        while (-not $task.AsyncWaitHandle.WaitOne(100)) { Update-LiveWaiters }
        $context = $task.GetAwaiter().GetResult()
        $request = $context.Request
        $response = $context.Response
        try {
            $path = $request.Url.AbsolutePath
            if (-not (Test-AllowedClient $request)) {
                Send-Text $response 403 'Forbidden'
            } elseif ($path -eq '/api/backup') {
                Invoke-Backup $request $response
            } elseif ($path -eq '/api/health' -or $path.StartsWith('/api/health/')) {
                Invoke-Health $request $response $path
            } elseif ($path -eq '/api/live') {
                Invoke-Live $request $response
            } elseif ($path -eq '/api/live/fit') {
                Invoke-LiveFit $request $response
            } elseif ($path -eq '/api/live/cmd') {
                Invoke-LiveCmd $request $response
            } elseif ($path -eq '/api/live/cmds') {
                Invoke-LiveCmds $request $response
            } elseif ($path -eq '/api/coach/status') {
                if ($request.HttpMethod -ne 'GET') { Send-Json $response 405 @{ error = 'Method not allowed' } }
                elseif (-not (Test-LocalRequest $request)) { Send-Json $response 403 @{ error = 'Forbidden' } }
                else { Send-Json $response 200 (Get-StatusObject) }
            } elseif ($path -eq '/api/coach') {
                if ($request.HttpMethod -ne 'POST') { Send-Json $response 405 @{ error = 'Method not allowed' } }
                else { Invoke-Coach $request $response }
            } elseif ($path -eq '/api/ask') {
                if ($request.HttpMethod -ne 'POST') { Send-Json $response 405 @{ error = 'Method not allowed' } }
                else { Invoke-Ask $request $response }
            } elseif ($path -eq '/api/strava/status') {
                if (-not (Test-LocalRequest $request)) { Send-Json $response 403 @{ error = 'Forbidden' } }
                else { Send-Json $response 200 (Get-StravaStatus) }
            } elseif ($path -eq '/api/strava/connect') {
                Invoke-StravaConnect $request $response
            } elseif ($path -eq '/api/strava/callback') {
                Invoke-StravaCallback $request $response
            } elseif ($path -eq '/api/strava/disconnect') {
                if ($request.HttpMethod -ne 'POST') { Send-Json $response 405 @{ error = 'Method not allowed' } }
                else { Invoke-StravaDisconnect $request $response }
            } elseif ($path -eq '/api/strava/upload') {
                if ($request.HttpMethod -ne 'POST') { Send-Json $response 405 @{ error = 'Method not allowed' } }
                else { Invoke-StravaUpload $request $response }
            } elseif ($path -eq '/api/strava/activities') {
                Invoke-StravaActivities $request $response
            } elseif ($path -eq '/api/strava/sync') {
                Invoke-StravaSync $request $response
            } elseif ($path -match '^/api/strava/upload/(\d+)$') {
                Invoke-StravaUploadStatus $request $response $Matches[1]
            } elseif ($path.StartsWith('/api/')) {
                Send-Json $response 404 @{ error = 'Not found' }
            } elseif ($request.HttpMethod -ne 'GET' -and $request.HttpMethod -ne 'HEAD') {
                Send-Text $response 405 'Method not allowed'
            } elseif (-not (Test-LocalRequest $request)) {
                # Pages and data files (your ride history) too: a website cannot read them via DNS rebinding.
                Send-Text $response 403 'Forbidden'
            } else {
                Send-StaticFile $request $response
            }
        } catch {
            Write-Host "Request error: $($_.Exception.Message)" -ForegroundColor Yellow
            try { Send-Json $response 500 @{ error = 'Internal error' } } catch { }
        }
        Update-LiveWaiters
    }
} finally {
    $listener.Stop()
    $http.Dispose()
}
