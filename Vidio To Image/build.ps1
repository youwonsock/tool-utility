$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonPath = Join-Path $projectRoot ".venv/Scripts/python.exe"
if (-not (Test-Path $pythonPath)) { throw "Developer build: prepare Python 3.14.6 and requirements-release.txt in .venv first." }
& $pythonPath (Join-Path $projectRoot "build_portable.py")
if ($LASTEXITCODE -ne 0) { throw "Portable build failed." }
