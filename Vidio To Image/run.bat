@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PACKAGED_EXE=%~dp0dist\VideoToImage\VideoToImage.exe"
if exist "%PACKAGED_EXE%" (
    start "" "%PACKAGED_EXE%"
    exit /b 0
)

set "PYTHON_EXE=%~dp0.venv\Scripts\python.exe"
if not exist "%PYTHON_EXE%" (
    echo First run: installing required components...
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
    if errorlevel 1 (
        echo Installation failed. Please run install.ps1 to see the details.
        pause
        exit /b 1
    )
)

if not exist "%PYTHON_EXE%" (
    echo Python environment was not created.
    pause
    exit /b 1
)

"%PYTHON_EXE%" "%~dp0video_to_image.py"
if errorlevel 1 pause
endlocal
