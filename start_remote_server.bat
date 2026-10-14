@echo off
chcp 65001 >nul
title X-Media-Downloader 安卓远程流媒体服务
echo ========================================================
echo   正在启动 X-Media-Downloader 安卓远程无线流媒体服务...
echo ========================================================
python "%~dp0start_remote_server.py"
if %errorlevel% neq 0 (
    echo.
    echo 提示: 未检测到 Python 环境，请确保已安装 Python 3 并将其添加到 PATH 环境变量中。
    pause
)
