@echo off
title X-Media-Downloader 安卓远程流媒体服务
set PYTHONDONTWRITEBYTECODE=1
set PYTHONIOENCODING=utf-8

cd /d "%~dp0"

where python >nul 2>&1
if %errorlevel% equ 0 (
    python -u -B "start_remote_server.py"
    goto finish
)

where py >nul 2>&1
if %errorlevel% equ 0 (
    py -u -B "start_remote_server.py"
    goto finish
)

echo.
echo ========================================================
echo [错误] 未在系统中检测到 Python 运行环境！
echo 请确保电脑已安装 Python 3 并添加到 PATH 环境变量。
echo 官方下载地址: https://www.python.org/downloads/
echo ========================================================

:finish
echo.
echo 服务已退出。按任意键关闭此窗口...
pause >nul