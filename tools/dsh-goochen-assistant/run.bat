@echo off
setlocal EnableExtensions
chcp 65001 >nul
title DeepSeek Harness Installer
cd /d "%~dp0"
rem This file MUST stay pure ASCII: cmd parses a .bat with the console's ANSI code page,
rem and a multi-byte character in a comment eats the following line (seen in the wild as
rem "'python.exe\" set \"PY" is not recognized" plus exit code 9009).
set "PY="
if exist "E:\Programs\Python\Python313\python.exe" set "PY=E:\Programs\Python\Python313\python.exe"
rem Prefer the official py launcher: a "python" on PATH is often the Microsoft Store stub,
rem which only opens the Store page instead of running the interpreter.
if not defined PY (where py >nul 2>&1 && set "PY=py -3")
if not defined PY (where python >nul 2>&1 && set "PY=python")
if not defined PY (echo [ERROR] Python 3.11+ not found. & echo Install it from https://www.python.org/downloads/windows/ & pause & exit /b 1)
echo Starting DeepSeek Harness Installer ...
%PY% "installer.py"
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (echo. & echo [ERROR] Exit code: %CODE% & pause)
exit /b %CODE%
