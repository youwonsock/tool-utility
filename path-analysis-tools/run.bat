@echo off
setlocal
set "PYTHONHOME="
set "PYTHONPATH="
"%~dp0portable\windows-x64\python\python.exe" -I -B -X utf8 "%~dp0launch.py" %*
exit /b %errorlevel%
