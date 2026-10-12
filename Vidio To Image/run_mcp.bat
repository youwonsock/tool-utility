@echo off
setlocal EnableExtensions
set "VIDEO_TOOLS_PYTHON=%~dp0.venv\Scripts\python.exe"
if not exist "%VIDEO_TOOLS_PYTHON%" (
    >&2 echo Run install_mcp.ps1 first.
    exit /b 1
)
"%VIDEO_TOOLS_PYTHON%" "%~dp0video_to_image_mcp.py" %*
exit /b %errorlevel%
