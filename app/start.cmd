@echo off
cd /d "%~dp0"
"C:\Users\Bruker\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" ".\server.js"
if errorlevel 1 pause
