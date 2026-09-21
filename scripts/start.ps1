# Jev Research — pull, build, and run (Windows PowerShell)
$ErrorActionPreference = "Stop"

Write-Host "==> Checking Node.js..." -ForegroundColor Cyan
node -v | Out-Null
npm -v | Out-Null

# Move to repo root (directory containing this script's parent)
$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root "package.json"))) {
  # If script lives at repo root /scripts, parent is root.
  # If user runs from elsewhere, try current directory.
  if (Test-Path ".\package.json") { $Root = (Get-Location).Path }
  else { throw "Run this from the jev-research repo (package.json not found)." }
}
Set-Location $Root
Write-Host "==> Repo: $Root" -ForegroundColor Cyan

Write-Host "==> Pulling latest..." -ForegroundColor Cyan
git pull

if (-not (Test-Path ".env")) {
  Write-Host "==> Creating .env from .env.example (edit TYPESAFE_API_KEY if needed)" -ForegroundColor Yellow
  Copy-Item ".env.example" ".env"
}

Write-Host "==> Installing dependencies..." -ForegroundColor Cyan
npm install

Write-Host "==> Building..." -ForegroundColor Cyan
npm run build

Write-Host "==> Checking Codex login status..." -ForegroundColor Cyan
npx --yes @openai/codex@0.155.1 login status

Write-Host "==> Starting Jev Research on http://127.0.0.1:8787 ..." -ForegroundColor Green
Write-Host "    Press Ctrl+C to stop." -ForegroundColor DarkGray
npm run dev
