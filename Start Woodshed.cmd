@echo off
rem Starts Woodshed on http://localhost:8642/ and opens it. Close this window to stop.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
