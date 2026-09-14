@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem ---- locate Node.js -------------------------------------------------
set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"

if not defined NODE_EXE (
  for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if not defined NODE_EXE if exist "%%~fD\node.exe" set "NODE_EXE=%%~fD\node.exe"
  )
)

if not defined NODE_EXE (
  if exist "%LOCALAPPDATA%\pi-node\current\node.exe" set "NODE_EXE=%LOCALAPPDATA%\pi-node\current\node.exe"
)

if not defined NODE_EXE (
  if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
)

if not defined NODE_EXE (
  echo.
  echo   [ERROR] Node.js not found in PATH.
  echo   Install Node 20 or newer: https://nodejs.org
  echo.
  pause
  exit /b 1
)

"%NODE_EXE%" "%~dp0tools\dev.mjs" %*
if errorlevel 1 pause
