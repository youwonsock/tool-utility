param([switch]$NoRegister)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    npm ci --cache (Join-Path $env:TEMP 'codex-opencode-npm-cache')
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
    if ($NoRegister) { node scripts/install.mjs --no-register } else { node scripts/install.mjs }
    if ($LASTEXITCODE -ne 0) { throw 'Install failed' }
} finally { Pop-Location }
