$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
node scripts/sync-icons.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
