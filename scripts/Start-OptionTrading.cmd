@echo off
rem Starts the Option Trading app and opens it in the browser. Point a desktop shortcut at this file.
cd /d "%~dp0.."
title Option Trading (close this window to stop the app)
call pnpm app
if errorlevel 1 pause
