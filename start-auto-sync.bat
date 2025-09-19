@echo off
echo Starting Auto-Sync in background...
cd /d "%~dp0"
start /min node auto-sync.js
echo Auto-Sync is now running in the background!
echo You can close this window - auto-sync will keep running.
pause
