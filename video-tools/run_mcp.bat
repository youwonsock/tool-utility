@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "VIDEO_TOOLS_PYTHON=%~dp0portable\windows-x64\python\python.exe"
if not exist "%VIDEO_TOOLS_PYTHON%" (
    >&2 echo Required bundled Python is missing. Download and extract the whole video-tools folder.
    exit /b 1
)
"%VIDEO_TOOLS_PYTHON%" -I -B -X utf8 "%~dp0launch.py" mcp %*
set "VIDEO_TOOLS_EXIT=%ERRORLEVEL%"
exit /b %VIDEO_TOOLS_EXIT%
