@echo off
title Apex Velo Lab Launcher
cd /d "%~dp0"
echo ===================================================
echo   Starting Apex Velo Lab with automatic local storage...
echo ===================================================

rem First run: create .env from the template.
if not exist ".env" copy ".env.example" ".env" >nul

echo.
echo   Ready to ride or explore: no account or API key is required.
echo   Optional AI keys and Strava settings can be added to .env later.
echo   First use may download a verified portable runtime. No manual install is needed.
echo   See docs\LOCAL-SETUP.md for setup and troubleshooting.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_server.ps1"
pause
