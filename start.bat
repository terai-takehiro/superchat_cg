@echo off
chcp 65001 > nul
cd /d "%~dp0"
rem ポート番号を変える場合は下の 3000 を書き換えてください
node server.js --port 3000
pause
