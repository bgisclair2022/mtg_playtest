@echo off
rem One-step setup: finds (or installs) Python, then install.py sets up Java, Forge, the bridge and the shortcut.
rem Safe to run again at any time; it skips whatever is already installed.
setlocal
cd /d "%~dp0"
title MTG Goldfish setup
set "PY="
for /f "delims=" %%i in ('py -3 -c "import sys; print(sys.executable)" 2^>nul') do set "PY=%%i"
if not defined PY for /f "delims=" %%i in ('python -c "import sys; print(sys.executable)" 2^>nul') do set "PY=%%i"
if not defined PY (
    echo Python isn't installed yet. Installing Python 3.12 with winget...
    winget install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements
    if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
)
if not defined PY (
    echo.
    echo Couldn't install Python automatically. Install Python 3.10 or newer from https://www.python.org/downloads/
    echo ^(tick "Add python.exe to PATH"^), then double-click setup.bat again.
    pause
    exit /b 1
)
"%PY%" install.py
if errorlevel 1 pause
