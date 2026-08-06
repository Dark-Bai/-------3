@echo off
setlocal
cd /d %~dp0
echo 正在启动市场研究驾驶舱, 服务就绪后将自动打开浏览器...
rem 后台轮询端口 3000, 就绪后打开系统默认浏览器(http://localhost:3000/)
start "" /min powershell.exe -NoProfile -WindowStyle Hidden -Command "while($true){try{(New-Object Net.Sockets.TcpClient).Connect('127.0.0.1',3000);Start-Process 'http://localhost:3000/';break}catch{Start-Sleep -Milliseconds 500}}"
npm start
pause