$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$distRoot = Join-Path $projectRoot "dist\VideoToImage"
$archivePath = Join-Path $projectRoot "dist\VideoToImage-win64.zip"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $projectRoot "build.ps1")
$buildExitCode = $LASTEXITCODE
if ($buildExitCode -ne 0) {
    throw "Build failed with exit code $buildExitCode."
}

if (-not (Test-Path -LiteralPath (Join-Path $distRoot "VideoToImage.exe") -PathType Leaf)) {
    throw "Build output was not found."
}

Write-Host "Creating portable ZIP package..."
Compress-Archive -Path (Join-Path $distRoot "*") -DestinationPath $archivePath -Force
Write-Host "Package complete: dist\VideoToImage-win64.zip" -ForegroundColor Green
