# APEX VELO LAB - local web server + Claude coach proxy (Windows PowerShell 5.1 or PowerShell 7).
#
# - Serves the app on http://localhost:8080 (a secure context, so Web Bluetooth works).
# - Forwards AI Coach requests from /api/coach to the Claude API. The API key is read here,
#   from the ANTHROPIC_API_KEY environment variable or the .env file next to this script.
#   It is never sent to the browser, and .env is never served.
# Keep the port stable: the browser stores your rides and settings per address (localhost:8080).

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)

# ------------------------------------------------------------------ config --
$keyFromEnvironment = -not [string]::IsNullOrWhiteSpace($env:ANTHROPIC_API_KEY)
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

$models = [ordered]@{
    'claude-opus-5-5'           = @{ label = 'Claude Opus 5.5';  adaptive = $true }
    'claude-sonnet-5'           = @{ label = 'Claude Sonnet 5';  adaptive = $true }
    'claude-haiku-4-5-20251001' = @{ label = 'Claude Haiku 4.5'; adaptive = $false }
}
$efforts = @('low', 'medium', 'high')

# A key set as an environment variable wins over .env; the APEX_* settings come from .env.
$apiKey = if ($keyFromEnvironment) { $env:ANTHROPIC_API_KEY.Trim() } else { (Get-Setting 'ANTHROPIC_API_KEY' '').Trim() }
$defaultModel = Get-Setting 'APEX_COACH_MODEL' 'claude-opus-5-5'
if (-not $models.Contains($defaultModel)) { $defaultModel = 'claude-opus-5-5' }
$defaultEffort = Get-Setting 'APEX_COACH_EFFORT' 'low'
if ($efforts -notcontains $defaultEffort) { $defaultEffort = 'low' }
$port = [int](Get-Setting 'APEX_PORT' '8080')
$apiBase = (Get-Setting 'APEX_ANTHROPIC_BASE_URL' 'https://api.anthropic.com').TrimEnd('/')
$maxBodyBytes = 256KB

$systemPrompt = "You are an elite cycling coach and exercise physiologist. You prescribe structured indoor ERG sessions " +
    "from the rider's real training data. Be specific and evidence-based, never invent data that is not in the request, " +
    "and reply with exactly the JSON object requested - no prose before or after it."

# HTTP client for the Claude API (TLS 1.2+ is required; older .NET defaults may not enable it).
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
function Test-LocalRequest($request) {
    $h = [string]$request.Headers['Host']
    $hostOk = ($h -match '^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$') -or ($h -match $lanHostRe)
    $origin = $request.Headers['Origin']
    $originOk = [string]::IsNullOrEmpty($origin) -or ($origin -match '^http://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$') -or (($origin -replace '^https?://', '') -match $lanHostRe)
    return ($hostOk -and $originOk)
}

# ---------------------------------------------------------------- phone view --
# The PC app posts a live snapshot about once a second; live.html on the phone reads it
# and queues simple commands that the PC app collects on its next post. Memory only.
$liveCmdsAllowed = @('toggle', 'skip', 'bias-up', 'bias-down', 'bias-reset')
$script:liveSnapshotJson = 'null'
$script:liveAt = $null
$script:liveCmds = New-Object System.Collections.ArrayList

function Invoke-Live($request, $response) {
    if (-not (Test-LocalRequest $request)) { return Send-Json $response 403 @{ error = 'Forbidden' } }
    if ($request.HttpMethod -eq 'GET') {
        $age = if ($script:liveAt) { [int]((Get-Date) - $script:liveAt).TotalMilliseconds } else { 'null' }
        $json = '{"snapshot":' + $script:liveSnapshotJson + ',"ageMs":' + $age + ',"pending":' + $script:liveCmds.Count + '}'
        return Send-RawJson $response 200 $json
    }
    if ($request.HttpMethod -ne 'POST') { return Send-Json $response 405 @{ error = 'Method not allowed' } }
    if ($request.ContentLength64 -gt 65536) { return Send-Json $response 413 @{ error = 'Request too large' } }
    $reader = New-Object System.IO.StreamReader($request.InputStream, $utf8)
    $bodyText = $reader.ReadToEnd(); $reader.Close()
    try { $null = $bodyText | ConvertFrom-Json } catch { return Send-Json $response 400 @{ error = 'Invalid JSON.' } }
    $script:liveSnapshotJson = $bodyText.Trim()
    if ($script:liveSnapshotJson -eq '') { $script:liveSnapshotJson = 'null' }
    $script:liveAt = Get-Date
    $parts = @(foreach ($c in $script:liveCmds) { '{"cmd":"' + $c + '"}' })
    $script:liveCmds.Clear()
    return Send-RawJson $response 200 ('{"cmds":[' + ($parts -join ',') + ']}')
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
    if ($script:liveCmds.Count -lt 20) { [void]$script:liveCmds.Add($cmd) }
    return Send-Json $response 200 @{ ok = $true }
}

function Get-StatusObject {
    $list = @()
    foreach ($id in $models.Keys) { $list += [ordered]@{ id = $id; label = $models[$id].label; effort = $models[$id].adaptive } }
    return [ordered]@{ provider = 'claude'; configured = ($apiKey -ne ''); model = $defaultModel; effort = $defaultEffort; models = $list; efforts = $efforts }
}

function Invoke-Coach($request, $response) {
    if (-not (Test-LocalRequest $request)) { return Send-Json $response 403 @{ error = 'Requests are only accepted from the app on localhost.' } }
    if ($request.ContentType -notmatch '^application/json\b') { return Send-Json $response 415 @{ error = 'Content-Type must be application/json.' } }
    if ($apiKey -eq '') { return Send-Json $response 503 @{ error = 'No Anthropic API key. Add ANTHROPIC_API_KEY to the .env file and restart Launch-Apex-Velo.bat.' } }
    if ($request.ContentLength64 -gt $maxBodyBytes) { return Send-Json $response 413 @{ error = 'Request too large' } }

    $reader = New-Object System.IO.StreamReader($request.InputStream, $utf8)
    $bodyText = $reader.ReadToEnd(); $reader.Close()
    if ($utf8.GetByteCount($bodyText) -gt $maxBodyBytes) { return Send-Json $response 413 @{ error = 'Request too large' } }
    try { $payload = $bodyText | ConvertFrom-Json } catch { return Send-Json $response 400 @{ error = 'Invalid JSON.' } }
    $prompt = if ($payload.prompt -is [string]) { $payload.prompt } else { '' }
    if ($prompt.Trim() -eq '' -or $prompt.Length -gt 100000) { return Send-Json $response 400 @{ error = 'A prompt of 1-100000 characters is required.' } }
    $model = if ($payload.model -is [string] -and $models.Contains($payload.model)) { $payload.model } else { $defaultModel }
    $effort = if ($payload.effort -is [string] -and $efforts -contains $payload.effort) { $payload.effort } else { $defaultEffort }
    $adaptive = $models[$model].adaptive

    $req = [ordered]@{
        model      = $model
        max_tokens = 16000
        system     = $systemPrompt
        messages   = @(@{ role = 'user'; content = $prompt })
    }
    if ($adaptive) {
        $req.thinking = [ordered]@{ type = 'adaptive'; display = 'summarized' }
        $req.output_config = @{ effort = $effort }
    } else {
        $req.thinking = [ordered]@{ type = 'enabled'; budget_tokens = 4000 }
    }
    $json = $req | ConvertTo-Json -Depth 8 -Compress

    $msg = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, "$apiBase/v1/messages")
    $msg.Headers.Add('x-api-key', $apiKey)
    $msg.Headers.Add('anthropic-version', '2023-06-01')
    $msg.Content = New-Object System.Net.Http.StringContent($json, $utf8, 'application/json')
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $upstream = $http.SendAsync($msg).GetAwaiter().GetResult()
        $text = $utf8.GetString($upstream.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult())
    } catch {
        $inner = $_.Exception
        while ($inner.InnerException) { $inner = $inner.InnerException }
        $timedOut = ($inner -is [System.Threading.Tasks.TaskCanceledException]) -or ($inner -is [System.TimeoutException])
        Write-Host "[coach] $model $(if ($timedOut) { 'timed out' } else { 'request failed: ' + $inner.Message })" -ForegroundColor Yellow
        if ($timedOut) { return Send-Json $response 504 @{ error = 'Claude did not answer in time.' } }
        return Send-Json $response 502 @{ error = "Could not reach the Claude API ($($inner.Message))." }
    } finally { $msg.Dispose() }

    $data = $null
    try { $data = $text | ConvertFrom-Json } catch { }
    $code = [int]$upstream.StatusCode
    if (-not $upstream.IsSuccessStatusCode) {
        $err = if ($data -and $data.error -and $data.error.message) { $data.error.message } else { "HTTP $code" }
        Write-Host "[coach] $model failed: $code $err" -ForegroundColor Yellow
        return Send-Json $response 502 @{ error = "Claude API error ${code}: $err"; upstreamStatus = $code }
    }
    $outText = ''; $thinking = @()
    foreach ($b in @($data.content)) {
        if ($b.type -eq 'text') { $outText += $b.text }
        elseif ($b.type -eq 'thinking' -and $b.thinking) { $thinking += $b.thinking }
    }
    $usage = if ($data.usage) { $data.usage } else { @{} }
    $shownEffort = if ($adaptive) { $effort } else { $null }
    $mode = if ($adaptive) { $effort } else { 'budget' }
    Write-Host ("[coach] {0} ({1}) {2:N1} s, {3} in / {4} out tokens, stop={5}" -f $model, $mode, $sw.Elapsed.TotalSeconds, $usage.input_tokens, $usage.output_tokens, $data.stop_reason)
    $modelOut = if ($data.model) { $data.model } else { $model }
    return Send-Json $response 200 ([ordered]@{ text = $outText; thinking = ($thinking -join "`n`n"); model = $modelOut; effort = $shownEffort; stopReason = $data.stop_reason; usage = $usage })
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
    if ($relative -match '(^|[\\/])\.' -or $relative -match '^server\.js$' -or $relative -match '\.(ps1|cmd|bat|sh)$') { return Send-Text $response 404 'Not found' }
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
    $eff = if ($models[$defaultModel].adaptive) { ", $defaultEffort effort" } else { '' }
    Write-Host "  AI Coach: $($models[$defaultModel].label)$eff (key from $src)" -ForegroundColor White
} else {
    Write-Host "  AI Coach: no API key - add ANTHROPIC_API_KEY to .env to enable Claude." -ForegroundColor Yellow
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
        while (-not $task.AsyncWaitHandle.WaitOne(500)) { }
        $context = $task.GetAwaiter().GetResult()
        $request = $context.Request
        $response = $context.Response
        try {
            $path = $request.Url.AbsolutePath
            if ($path -eq '/api/live') {
                Invoke-Live $request $response
            } elseif ($path -eq '/api/live/cmd') {
                Invoke-LiveCmd $request $response
            } elseif ($path -eq '/api/coach/status') {
                if ($request.HttpMethod -ne 'GET') { Send-Json $response 405 @{ error = 'Method not allowed' } }
                elseif (-not (Test-LocalRequest $request)) { Send-Json $response 403 @{ error = 'Forbidden' } }
                else { Send-Json $response 200 (Get-StatusObject) }
            } elseif ($path -eq '/api/coach') {
                if ($request.HttpMethod -ne 'POST') { Send-Json $response 405 @{ error = 'Method not allowed' } }
                else { Invoke-Coach $request $response }
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
            } elseif ($path -match '^/api/strava/upload/(\d+)$') {
                Invoke-StravaUploadStatus $request $response $Matches[1]
            } elseif ($path.StartsWith('/api/')) {
                Send-Json $response 404 @{ error = 'Not found' }
            } elseif ($request.HttpMethod -ne 'GET' -and $request.HttpMethod -ne 'HEAD') {
                Send-Text $response 405 'Method not allowed'
            } else {
                Send-StaticFile $request $response
            }
        } catch {
            Write-Host "Request error: $($_.Exception.Message)" -ForegroundColor Yellow
            try { Send-Json $response 500 @{ error = 'Internal error' } } catch { }
        }
    }
} finally {
    $listener.Stop()
    $http.Dispose()
}
