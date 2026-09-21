@echo off
setlocal EnableExtensions
chcp 65001 >nul
title DeepSeek Harness - dsh web
cd /d "%~dp0"

rem This script must sit at the repository root (next to pnpm-workspace.yaml).
if not exist "pnpm-workspace.yaml" goto :not_repo
if not exist "package.json" goto :not_repo

rem Parse arguments: --fresh forces reinstall + rebuild; all other
rem arguments are passed through to "dsh web" verbatim (e.g. --no-open).
set "FRESH=0"
set "WEB_ARGS="

:arg_loop
if "%~1"=="" goto :args_done
if /i "%~1"=="--fresh" goto :arg_fresh
set "WEB_ARGS=%WEB_ARGS% %~1"
goto :arg_next
:arg_fresh
set "FRESH=1"
:arg_next
shift
goto :arg_loop
:args_done

rem >>>>> Environment preflight <<<<<
where node >nul 2>&1
if errorlevel 1 goto :no_node
for /f "delims=" %%v in ('node -p "process.versions.node"') do set "NODE_VER=%%v"

node -e "const [M,m]=process.versions.node.split('.').map(Number);process.exit((M===22&&m>=19)||M>=24?0:1)"
if errorlevel 1 goto :node_version

where pnpm >nul 2>&1
if errorlevel 1 goto :no_pnpm

echo.
echo ===== DeepSeek Harness - one-click start (dsh web) =====
echo.

rem >>>>> Install / build only when needed: node_modules first, artifacts second <<<<<
if "%FRESH%"=="1" goto :do_install
if not exist "node_modules" goto :do_install
if not exist ".dsh-build\client-build-environment.json" goto :do_build
goto :start_web

:do_install
echo [1/2] Installing dependencies: pnpm install ...
call pnpm install
if errorlevel 1 goto :fail_install

:do_build
echo [2/2] Building artifacts: pnpm run build ...
call pnpm run build
if errorlevel 1 goto :fail_build

:start_web
rem Clock overlay: mounted via the plugin project patch unless the profile's own
rem patch layer already mounts time-context (skip --patch to avoid a duplicate row).
set "CLOCK_PATCH=%~dp0plugins\time-context\cordis.patch.yml"
set "HOME_PATCH=%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml"
set "CLOCK_ARGS="
if not exist "%CLOCK_PATCH%" goto :clock_done
if exist "%HOME_PATCH%" findstr /C:"dsh-time-context" "%HOME_PATCH%" >nul 2>&1 && goto :clock_done
set CLOCK_ARGS=--patch "%CLOCK_PATCH%"
:clock_done
echo Starting Web UI ...
echo.
echo   URL: http://127.0.0.1:3080
if not "%WEB_ARGS%"=="" echo   Extra args:%WEB_ARGS%
if defined CLOCK_ARGS echo   Clock overlay: time-context (%CLOCK_PATCH%)
echo   A local launch opens the default browser automatically; if it does not,
echo   open the URL above manually.
echo   Model API key: configure inside the Web UI, or write DEEPSEEK_API_KEY=...
echo   into the .env file at the repository root.
echo   Press Ctrl+C to stop the server.
echo.
call pnpm dsh web %WEB_ARGS% %CLOCK_ARGS%
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo dsh web exited with code %EXIT_CODE%
pause
exit /b %EXIT_CODE%

rem >>>>> Error branches <<<<<
:not_repo
echo.
echo [X] This is not the deepseek-harness repository root.
echo     Put start-dsh-web.bat next to pnpm-workspace.yaml and run again.
goto :fail_common

:no_node
echo.
echo [X] Node.js was not found. Install Node.js 22.19+ or 24+ first.
echo     Download: https://nodejs.org/
goto :fail_common

:node_version
echo.
echo [X] Current Node.js version is %NODE_VER% (need 22.19+ or 24+).
echo     Install or switch to a supported Node.js version and retry.
goto :fail_common

:no_pnpm
echo.
echo [X] pnpm was not found.
echo     Option 1: corepack enable
echo     Option 2: npm install -g pnpm
goto :fail_common

:fail_install
echo.
echo [X] pnpm install failed. Fix the reported error (common: network or registry) and retry.
goto :fail_common

:fail_build
echo.
echo [X] pnpm run build failed. Fix the reported error and retry.
goto :fail_common

:fail_common
echo.
pause
exit /b 1
