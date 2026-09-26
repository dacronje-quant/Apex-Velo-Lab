@echo off
title Apex Velo Lab Launcher
cd /d "%~dp0"
echo ===================================================
echo   Starting Apex Velo Lab with Web Bluetooth...
echo ===================================================

rem First run: create .env from the template.
if not exist ".env" copy ".env.example" ".env" >nul

rem Ask for an AI Coach key once: open .env if it has neither a Claude nor a Gemini key
rem and none is set in the environment.
set "APEX_HAS_KEY="
if defined ANTHROPIC_API_KEY set "APEX_HAS_KEY=1"
if defined GEMINI_API_KEY set "APEX_HAS_KEY=1"
findstr /r /c:"^ANTHROPIC_API_KEY=..*" ".env" >nul && set "APEX_HAS_KEY=1"
findstr /r /c:"^GEMINI_API_KEY=..*" ".env" >nul && set "APEX_HAS_KEY=1"
if not defined APEX_HAS_KEY (
  echo.
  echo   The AI Coach needs an API key: Anthropic ^(Claude^) and/or Google ^(Gemini^).
  echo   Paste it after ANTHROPIC_API_KEY= or GEMINI_API_KEY= in Notepad, save, then close Notepad.
  echo   ^(Leave both empty to use the offline coach.^)
  echo.
  notepad ".env"
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_server.ps1"
pause
