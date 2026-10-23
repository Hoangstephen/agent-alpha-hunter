@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
where baw >nul 2>nul || call npm i -g @binance/agentic-wallet@1.11.0
npm start
pause
