@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d %~dp0
title 市场研究驾驶舱 - 启动器

echo ============================================
echo   市场研究驾驶舱 - 启动器
echo ============================================
echo.

rem 若前端(3000)已在运行: 直接打开浏览器, 不重复启动
rem 注: Vite 默认仅监听 IPv6 回环(::1), 仅探测 127.0.0.1(IPv4) 会误判未运行导致 EADDRINUSE, 故 localhost 与 127.0.0.1 双地址探测
powershell.exe -NoProfile -WindowStyle Hidden -Command "try{(New-Object Net.Sockets.TcpClient).Connect('localhost',3000);exit 0}catch{try{(New-Object Net.Sockets.TcpClient).Connect('127.0.0.1',3000);exit 0}catch{exit 1}}"
if not errorlevel 1 (
    echo 检测到服务已在运行, 正在打开浏览器...
    start "" "http://localhost:3000/"
    echo.
    pause
    exit /b 0
)

echo 正在启动服务, 就绪后将自动打开浏览器 http://localhost:3000/ ...
echo (首次启动需数秒, 请勿关闭本窗口; 关闭本窗口将停止服务)
echo.

rem 后台轮询端口 3000(localhost/IPv6 与 127.0.0.1/IPv4 双地址探测), 就绪后自动打开系统默认浏览器(最多等待 120 秒)
start "" /min powershell.exe -NoProfile -WindowStyle Hidden -Command "$c=0;while($true){try{(New-Object Net.Sockets.TcpClient).Connect('localhost',3000);Start-Process 'http://localhost:3000/';exit}catch{try{(New-Object Net.Sockets.TcpClient).Connect('127.0.0.1',3000);Start-Process 'http://localhost:3000/';exit}catch{$c++;if($c-ge 240){exit};Start-Sleep -Milliseconds 500}}"

rem 启动完整服务(vite 前端 :3000 + API :3001 + THS 数据网关)
call npm run dev

echo.
echo 服务已停止。按任意键关闭窗口...
pause >nul
