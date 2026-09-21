@echo off
setlocal EnableExtensions
chcp 65001 >nul
title DeepSeek Harness Installer
cd /d "%~dp0"
set "PY="
if exist "E:\Programs\Python\Python313\python.exe" set "PY=E:\Programs\Python\Python313\python.exe"
rem PATH 上的 python 在不少机器上是 Microsoft Store 的占位程序（跑起来只会打开应用商店），
rem 所以先试官方 py 启动器，再退回 python。
if not defined PY (where py >nul 2>&1 && set "PY=py -3")
if not defined PY (where python >nul 2>&1 && set "PY=python")
if not defined PY (echo [ERROR] Python 3.11+ not found. & echo Install: https://www.python.org/downloads/windows/ & pause & exit /b 1)
echo Starting DeepSeek Harness Installer ...
%PY% "installer.py"
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (echo. & echo [ERROR] Exit code: %CODE% & pause)
exit /b %CODE%
