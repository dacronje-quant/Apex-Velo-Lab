@echo off
setlocal
rem One-time setup so your phone (same home Wi-Fi) can open the Apex Velo Lab phone view.
rem It (1) lets the app's server listen on your home network and (2) opens that port in
rem Windows Firewall for PRIVATE networks only. Safe to run again.
rem To undo: run it with the word "remove", e.g.  Enable-Phone-View.bat remove

cd /d "%~dp0"

rem --- need administrator rights: relaunch elevated if we don't have them ---
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Asking Windows for administrator permission - click Yes on the prompt...
  if "%~1"=="" (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  ) else (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%~1' -Verb RunAs"
  )
  exit /b
)

rem --- port: APEX_PORT from .env, else 8080 ---
set "PORT=8080"
if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
    if /i "%%A"=="APEX_PORT" if not "%%B"=="" set "PORT=%%B"
  )
)

if /i "%~1"=="remove" goto remove

echo.
echo ==========================================================
echo   Apex Velo Lab - enabling phone view on port %PORT%
echo ==========================================================
echo.
netsh http delete urlacl url=http://+:%PORT%/ >nul 2>&1
rem D:(A;;GX;;;WD) = allow Everyone; works on any Windows language.
netsh http add urlacl url=http://+:%PORT%/ sddl=D:(A;;GX;;;WD)
if %errorlevel% neq 0 echo [!] Could not add the URL reservation (see message above).
netsh advfirewall firewall delete rule name="Apex Velo Lab (phone view)" >nul 2>&1
netsh advfirewall firewall add rule name="Apex Velo Lab (phone view)" dir=in action=allow protocol=TCP localport=%PORT% profile=private
if %errorlevel% neq 0 echo [!] Could not add the firewall rule (see message above).

echo.
echo --- Check ---
netsh http show urlacl url=http://+:%PORT%/ | findstr /i "Reserved" >nul && (echo [OK] Server may listen on your home network) || (echo [!!] URL reservation missing)
netsh advfirewall firewall show rule name="Apex Velo Lab (phone view)" >nul 2>&1 && (echo [OK] Firewall rule present for Private networks) || (echo [!!] Firewall rule missing)
powershell -NoProfile -Command "$p = Get-NetConnectionProfile | Where-Object { $_.IPv4Connectivity -ne 'Disconnected' }; foreach ($x in $p) { if ($x.NetworkCategory -eq 'Private') { Write-Host ('[OK] Network ''' + $x.Name + ''' is Private') } else { Write-Host ('[!!] Network ''' + $x.Name + ''' is ' + $x.NetworkCategory + ' - the phone cannot connect until it is Private.') -ForegroundColor Yellow; Write-Host '     Fix: Settings > Network & internet > Wi-Fi (or Ethernet) > your network > Network profile type: Private' -ForegroundColor Yellow } }"
echo.
echo Your phone address(es) - open in Safari on the same Wi-Fi:
powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -and $_.AddressState -eq 'Preferred' } | ForEach-Object { Write-Host ('   http://' + $_.IPAddress + ':%PORT%/live.html') -ForegroundColor Green }"
echo.
echo Next: close the Apex Velo Lab server window (if open) and start Launch-Apex-Velo.bat again.
echo.
pause
exit /b

:remove
netsh http delete urlacl url=http://+:%PORT%/
netsh advfirewall firewall delete rule name="Apex Velo Lab (phone view)"
echo Phone view access removed.
pause
