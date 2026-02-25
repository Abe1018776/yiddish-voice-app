@echo off
set PATH=%USERPROFILE%\.nodejs\node-v22.12.0-win-x64;%PATH%
cd /d "%~dp0"
npx electron .
