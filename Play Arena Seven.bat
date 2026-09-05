@echo off
title Arena Seven - dev server
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
echo Starting the game server. Keep this window open while you play.
start "" cmd /c "timeout /t 4 /nobreak >nul && start msedge http://localhost:5173"
call npm run dev
