@echo off
rem UAT demo: a separate copy with a sample company, jobs (on the Material + Labour price book), staff and schedules.
rem Uses its own data folder and port, so it never touches real company data.
title Vicello Pricing Platform - UAT DEMO
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
set "DATA_DIR=%LOCALAPPDATA%\JoineryPricing-uat"
set "PORT=4330"
if not exist "%DATA_DIR%\platform.db" (
  echo Creating the UAT demo company and sample jobs...
  "%NODE%" scripts\create-demo.js
  echo.
)
echo UAT DEMO - sign-in details are in scripts\demo-credentials.json
echo Keep this window open while testing. Close it to stop the demo.
echo.
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:4330"
"%NODE%" server\index.js
pause
