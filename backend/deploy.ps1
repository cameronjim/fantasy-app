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
npx serverless deploy
