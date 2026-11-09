@echo off
rem Wipes the UAT demo data and recreates the sample company. Real company data is not affected.
title Reset UAT demo
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
set "DATA_DIR=%LOCALAPPDATA%\JoineryPricing-uat"
echo This deletes ALL UAT demo data in:
echo   %DATA_DIR%
echo and creates a fresh sample company. Close the "UAT DEMO" window first.
echo Your real company data is not touched.
echo.
choice /c YN /m "Reset the UAT demo now"
if errorlevel 2 exit /b 0
if exist "%DATA_DIR%" rmdir /s /q "%DATA_DIR%"
if exist "%DATA_DIR%\platform.db" (
  echo Could not delete the demo data. Is the UAT DEMO window still open? Close it and try again.
  pause
  exit /b 1
)
"%NODE%" scripts\create-demo.js
echo.
echo Done. Run "UAT - Start Demo.cmd" to test.
pause
