param([Parameter(Mandatory=$true)][string]$Workspace)
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonPath = Join-Path $projectRoot ".venv\Scripts\python.exe"

& (Join-Path $projectRoot "install.ps1")
& $pythonPath -m pip install -r (Join-Path $projectRoot "requirements-mcp.txt")
if ($LASTEXITCODE -ne 0) { throw "MCP dependency installation failed." }

$configPath = Join-Path $projectRoot "mcp-config.local.json"
& $pythonPath (Join-Path $projectRoot "configure_mcp.py") --workspace $Workspace --output $configPath
if ($LASTEXITCODE -ne 0) { throw "MCP configuration generation failed." }
Write-Host "MCP ready. Merge the video-tools entry from $configPath into your MCP client's configuration."
