@echo off
setlocal
chcp 65001 >nul
title QSA-RAG
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 24 or newer is required. Install it, then reopen this launcher.
  pause
  exit /b 1
)
node "%~dp0scripts\start.mjs"
if errorlevel 1 (
  echo.
  echo Startup failed. See the message above.
  pause
  exit /b 1
)
