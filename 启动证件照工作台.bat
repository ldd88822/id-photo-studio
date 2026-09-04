@echo off
chdir /d "%~dp0"
set "PY=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"
if not exist "%PY%" set "PY=python"
start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:8848/index.html"
"%PY%" -m http.server 8848 --bind 127.0.0.1
