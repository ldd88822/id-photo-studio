@echo off
chcp 936 >nul
title 证件照工作台 - 本地服务（关闭本窗口即停止）
chdir /d "%~dp0"
set "PY=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"
if not exist "%PY%" set "PY=python"
echo 正在启动证件照工作台，浏览器会自动打开...
echo 提示：关闭本窗口即停止服务。
echo.
"%PY%" "_serve.py" 8848
if errorlevel 1 pause
