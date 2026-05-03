# Start the LangGraph agent (port 8001)
# Usage: .\scripts\start-agent.ps1
# Optional -Dev flag enables --watch for auto-restart on file changes.
#
# Required agent\.env variables for the remediation path:
#   REPO_URL       - e.g. https://github.com/yiftachbz/prod-incident-agent.git
#   REPO_BRANCH    - default master
#   GITHUB_TOKEN   - PAT with repo + PR access
#   APP_BASE_URL   - base URL of the running app server (e.g. http://localhost:3001)
#   LOGS_TOKEN     - shared secret matching LOGS_TOKEN in app/server/.env
#   GIT_DEFAULT_BRANCH - base branch for PRs (default master)
#
# Local dev override (optional — skips git clone):
#   REPO_ROOT      - absolute path to a local repo checkout

param(
  [switch]$Dev
)

$agentDir = Join-Path $PSScriptRoot "..\agent"

if (-not (Test-Path (Join-Path $agentDir "node_modules"))) {
  Write-Host "Installing agent dependencies..." -ForegroundColor Cyan
  Push-Location $agentDir
  npm install
  Pop-Location
}

# Kill any process already using port 8001
$port = 8001
$existing = netstat -ano | Select-String ":$port\s.*LISTENING" | ForEach-Object {
  ($_ -split '\s+')[-1]
} | Select-Object -Unique

foreach ($procId in $existing) {
  if ($procId -match '^\d+$') {
    Write-Host "Killing PID $procId (was using port $port)..." -ForegroundColor Yellow
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  }
}

Push-Location $agentDir
if ($Dev) {
  Write-Host "Starting agent in dev/watch mode on port 8001..." -ForegroundColor Green
  npm run dev
} else {
  Write-Host "Starting agent on port 8001..." -ForegroundColor Green
  npm start
}
Pop-Location
