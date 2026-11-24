@echo off
chcp 65001 >nul
title Gugu Grab - uninstall
cd /d "%~dp0"

echo.
echo   This removes the autostart entry and the saved folder setting.
echo   Your downloaded files are NOT touched.
echo.
set /p ok="Continue? (y/n): "
if /i not "%ok%"=="y" goto end

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Gugu Grab helper.lnk'; if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force; Write-Host '  autostart removed' } else { Write-Host '  no autostart entry' }"

if exist "%~dp0config.json" (
  del /q "%~dp0config.json"
  echo   folder setting cleared
)
if exist "%~dp0python-path.txt" del /q "%~dp0python-path.txt"

echo.
echo   Done. You can also remove the extension from chrome://extensions.
echo   Then delete this folder.
echo.

:end
pause
