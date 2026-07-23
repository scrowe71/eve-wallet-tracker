@echo off
setlocal
cd /d %~dp0

if not exist .venv (
  py -3.12 -m venv .venv
)
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt

pyinstaller --noconfirm --clean --windowed --name "EVE Wallet Tracker" ^
  --add-data "app\templates;app\templates" ^
  --add-data "app\static;app\static" ^
  --hidden-import webview.platforms.edgechromium ^
  desktop_launcher.py

if errorlevel 1 exit /b 1

echo.
echo Build complete: dist\EVE Wallet Tracker\EVE Wallet Tracker.exe
endlocal
