@echo off
chcp 65001 >nul
title Gugu Grab - setup
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
