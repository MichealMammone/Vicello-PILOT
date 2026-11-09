@echo off
rem Starts the pricing platform on this computer and opens it in the default browser.
title Vicello Pricing Platform
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE=%ProgramFiles%\nodejs\node.exe"
  ) else (
    echo Node.js is not installed. Install Node.js 22 LTS or newer from https://nodejs.org and run this again.
    pause
    exit /b 1
  )
)
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:4310"
echo Keep this window open while you use the program. Close it to stop the program.
echo.
"%NODE%" server\index.js
pause
