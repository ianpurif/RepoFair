@echo off
cd /d "%~dp0"
node scripts\launch-codex.mjs
if errorlevel 1 pause
