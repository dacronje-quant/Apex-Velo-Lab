@echo off
title Apex Velo Lab Launcher
cd /d "%~dp0"
echo ===================================================
echo   Starting Apex Velo Lab with Web Bluetooth...
echo ===================================================

rem First run: create .env from the template.
if not exist ".env" copy ".env.example" ".env" >nul

rem Ask for the Claude API key once: open .env if it has no key and none is set in the environment.
if not defined ANTHROPIC_API_KEY (
  findstr /r /c:"^ANTHROPIC_API_KEY=..*" ".env" >nul
  if errorlevel 1 (
    echo.
    echo   The AI Coach needs your Anthropic API key.
    echo   Paste it after ANTHROPIC_API_KEY= in Notepad, save, then close Notepad.
    echo   ^(Leave it empty to use the offline coach.^)
    echo.
    notepad ".env"
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_server.ps1"
pause
