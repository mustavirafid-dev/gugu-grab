@echo off
chcp 65001 >nul
title Gugu Grab - helper
cd /d "%~dp0"

set "PY="
if exist "%~dp0python-path.txt" (
  for /f "usebackq delims=" %%L in ("%~dp0python-path.txt") do (
    if not defined PY set "PY=%%L"
  )
)

if not defined PY (
  echo.
  echo   Run setup.bat first.
  echo.
  pause
  exit /b 1
)

"%PY%" helper.py
echo.
echo Helper stopped.
pause
