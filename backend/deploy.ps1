# Legacy hand-deploy script. Prefer GitHub Actions:
#   - merge PR to main         -> auto-deploys to prod
#   - push to any PR branch    -> auto-deploys to dev (preview)
# This script remains for emergency manual deploys (e.g. GitHub Actions outage,
# or testing an uncommitted local change against real AWS). Note: running it
# against the `dev` stage will fight the workflow over Lambda env vars, since
# this reads .env and the workflow reads GitHub Secrets — use `--stage scratch`
# (or any unused stage) if you really need to hand-deploy without disrupting
# the PR-preview environment.
#
# Loads env vars from the repo-root .env file, compiles TypeScript, and deploys.
#
# Usage:
#   cd C:\Users\CJ\code\fantasy-app\backend
#   .\deploy.ps1

$ErrorActionPreference = 'Stop'

$envFile = Join-Path $PSScriptRoot '..\.env'
if (-not (Test-Path $envFile)) {
    Write-Error "No .env file found at $envFile"
    exit 1
}

Write-Host "Loading env vars from $envFile" -ForegroundColor Cyan

Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { return }
    if ($line -match '^([^=]+?)\s*=\s*(.*)$') {
        $name = $matches[1].Trim()
        $value = $matches[2].Trim()
        if ($value -match '^"(.*)"$' -or $value -match "^'(.*)'$") {
            $value = $matches[1]
        }
        Set-Item -Path "Env:$name" -Value $value
        Write-Host "  $name" -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host "Compiling TypeScript..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Error "TypeScript build failed. Aborting deploy."
    exit 1
}

Write-Host ""
Write-Host "Running serverless deploy..." -ForegroundColor Cyan
npx serverless@3 deploy
