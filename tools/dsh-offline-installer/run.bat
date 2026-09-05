@echo off
setlocal EnableExtensions
chcp 65001 >nul
title DeepSeek Harness Installer
cd /d "%~dp0"
set "PY="
if exist "E:\Programs\Python\Python313\python.exe" set "PY=E:\Programs\Python\Python313\python.exe"
if not defined PY (where py >nul 2>&1 && set "PY=py")
if not defined PY (where python >nul 2>&1 && set "PY=python")
if not defined PY (echo [ERROR] Python 3.11+ not found. & pause & exit /b 1)
echo Starting DeepSeek Harness Installer ...
%PY% "installer.py"
set "CODE=0"
if not "%CODE%"=="0" (echo. & echo [ERROR] Exit code: %CODE% & pause)
exit /b %CODE%
