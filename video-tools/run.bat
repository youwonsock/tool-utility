@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "VIDEO_TOOLS_PYTHON=%~dp0portable\windows-x64\python\python.exe"
if not exist "%VIDEO_TOOLS_PYTHON%" (
    >&2 echo Required bundled Python is missing. Clone the repository again.
    pause
    exit /b 1
)
"%VIDEO_TOOLS_PYTHON%" -I -B -X utf8 "%~dp0launch.py" gui %*
set "VIDEO_TOOLS_EXIT=%ERRORLEVEL%"
if not "%VIDEO_TOOLS_EXIT%"=="0" pause
exit /b %VIDEO_TOOLS_EXIT%
