$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvPath = Join-Path $projectRoot ".venv"
$pythonPath = Join-Path $venvPath "Scripts\python.exe"
$scriptPath = Join-Path $projectRoot "video_to_image.py"

if (-not (Test-Path $pythonPath)) {
    Write-Host "Virtual environment not found. Run install.ps1 first."
    exit 1
}

Write-Host "Installing build tools..."
& $pythonPath -m pip install -r (Join-Path $projectRoot "requirements-build.txt")
$pipExitCode = $LASTEXITCODE
if ($pipExitCode -ne 0) {
    throw "Build tool installation failed with exit code $pipExitCode."
}

$ffmpegPath = & $pythonPath -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"
if ($LASTEXITCODE -ne 0 -or -not $ffmpegPath -or -not (Test-Path -LiteralPath $ffmpegPath -PathType Leaf)) {
    throw "FFmpeg binary was not found: $ffmpegPath"
}

Write-Host "Building VideoToImage.exe..."
& $pythonPath -m PyInstaller `
    --noconfirm `
    --clean `
    --onedir `
    --windowed `
    --name VideoToImage `
    --add-binary "$ffmpegPath;ffmpeg" `
    $scriptPath
$pyinstallerExitCode = $LASTEXITCODE
if ($pyinstallerExitCode -ne 0) {
    throw "PyInstaller build failed with exit code $pyinstallerExitCode."
}

$exePath = Join-Path $projectRoot "dist\VideoToImage\VideoToImage.exe"
if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) {
    throw "Build output was not found: $exePath"
}

Write-Host "Build complete: dist\VideoToImage\VideoToImage.exe" -ForegroundColor Green
