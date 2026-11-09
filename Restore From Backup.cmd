@echo off
rem Restore a backup into this PC's live data folder (%LOCALAPPDATA%\JoineryPricing).
rem Close the program first. The current data is copied to the backups folder before anything changes.
title Vicello Pricing Platform - Restore from backup
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install it from https://nodejs.org ^(LTS^), then try again. & pause & exit /b 1)
echo.
echo  RESTORE FROM BACKUP
echo  -------------------
echo  Use a backup downloaded from Settings ^> Backups ^& restore (.db),
echo  or an encrypted off-site backup (.vbak) downloaded from Backblaze.
echo.
node scripts\restore.js %1
echo.
pause
