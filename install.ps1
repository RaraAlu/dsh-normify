$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'Install Node.js 22 or newer with npm first.'
    exit 1
}
& node (Join-Path $PSScriptRoot 'scripts\setup.mjs') @args
exit $LASTEXITCODE
