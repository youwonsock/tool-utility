$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvPath = Join-Path $projectRoot ".venv"
$pythonPath = Join-Path $venvPath "Scripts\python.exe"

if (-not (Test-Path $pythonPath)) {
    Write-Host "Creating virtual environment..."
    python -m venv $venvPath
}

Write-Host "Installing required components..."
& $pythonPath -m pip install --upgrade pip
& $pythonPath -m pip install -r (Join-Path $projectRoot "requirements.txt")

Write-Host "Installation complete. Run run.bat." -ForegroundColor Green
