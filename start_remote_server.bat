@echo off
setlocal
cd /d "%~dp0"
title X-Media 本地流媒体服务与 WEB 控制总台

echo ========================================================
echo   正在启动 X-Media 本地流媒体服务与 WEB 控制总台...
echo   服务就绪后将自动在您的默认浏览器中打开控制台
echo ========================================================
echo.

where python >nul 2>&1
if %errorlevel% equ 0 (
    python -u -B "start_remote_server.py" %*
    goto finish
)

where py >nul 2>&1
if %errorlevel% equ 0 (
    py -u -B "start_remote_server.py" %*
    goto finish
)

echo.
echo ========================================================
echo [错误] 未在您的电脑上检测到 Python 环境！
echo 请先安装 Python 3 并勾选 Add Python to PATH。
echo 官方下载地址: https://www.python.org/downloads/
echo ========================================================
pause

:finish
