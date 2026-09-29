@echo off
rem One-time setup: installs the Python dependency and adds "MTG Goldfish" to the desktop and Start menu.
cd /d "%~dp0"
python -m pip install --quiet -r requirements.txt
if errorlevel 1 (
    echo.
    echo Python 3.10 or newer is required: https://www.python.org/downloads/
    pause
    exit /b 1
)
python shortcut.py
echo.
echo Done. Open "MTG Goldfish" from your desktop. Forge can be installed from the app's Settings tab.
pause
