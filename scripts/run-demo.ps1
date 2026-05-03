# -----------------------------------------------------------------------------
# run-demo.ps1  -  Runs the full prod-incident-agent demonstration.
#
# Usage:
#   .\scripts\run-demo.ps1
#   .\scripts\run-demo.ps1 -SkipRemediate  # skip the /remediate step
#   .\scripts\run-demo.ps1 -NoStart        # assume agent is already running
#
# Required env vars (set in agent\.env before running):
#   SERVICENOW_INSTANCE, SERVICENOW_USER, SERVICENOW_PASSWORD
#   OPENAI_API_KEY (or OPENAI_BASE_URL + OPENAI_API_KEY for LiteLLM)
#   REPO_URL        - e.g. https://github.com/yiftachbz/prod-incident-agent.git
#   REPO_BRANCH     - default master
#   GITHUB_TOKEN    - PAT with repo read/write + PR creation access
#   APP_BASE_URL    - e.g. http://localhost:3001  (running app server)
#   LOGS_TOKEN      - shared secret matching LOGS_TOKEN in app/server/.env
#
# NOTE: this file is intentionally pure ASCII. Windows PowerShell 5.1 reads
# BOM-less files as Windows-1252, so any UTF-8 byte sequence inside a string
# literal can be mis-decoded into a curly-quote that terminates the string
# and breaks the parser.
# -----------------------------------------------------------------------------
param(
  [switch]$SkipRemediate,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$agentUrl = "http://localhost:8001"
$appUrl   = "http://localhost:3001"

# -- helpers ------------------------------------------------------------------

function Write-Header([string]$text) {
  Write-Host ""
  Write-Host ("=" * 60) -ForegroundColor DarkCyan
  Write-Host "  $text" -ForegroundColor Cyan
  Write-Host ("=" * 60) -ForegroundColor DarkCyan
}

function Write-Step([string]$label, [string]$value) {
  $l = $label.PadRight(22)
  if ($value -match "^(http|PASSED|OK\]|FAIL\])") {
    $color = if ($value -match "PASSED|OK\]|http") { "Green" } else { "Red" }
    Write-Host "  $l" -NoNewline
    Write-Host $value -ForegroundColor $color
  } else {
    Write-Host "  $l$value"
  }
}

function Wait-ForAgent {
  Write-Host "[demo] Waiting for agent on port 8001..." -ForegroundColor Yellow
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-RestMethod "$agentUrl/health" -TimeoutSec 2
      if ($r.ok) {
        Write-Host "[demo] Agent is up. ServiceNow: $($r.instance)" -ForegroundColor Green
        return
      }
    } catch { }
    Start-Sleep -Seconds 2
  }
  throw "Agent did not become ready within 60 s."
}

function Invoke-AgentPost([string]$path, [hashtable]$body) {
  $json = $body | ConvertTo-Json -Depth 5
  $response = Invoke-RestMethod `
    -Uri         "$agentUrl$path" `
    -Method      POST `
    -Body        $json `
    -ContentType "application/json" `
    -TimeoutSec  300
  return $response
}

# -- 1. Start agent -----------------------------------------------------------

if (-not $NoStart) {
  $alreadyUp = $false
  try {
    $h = Invoke-RestMethod "$agentUrl/health" -TimeoutSec 2
    if ($h.ok) { $alreadyUp = $true }
  } catch { }

  if ($alreadyUp) {
    Write-Host "[demo] Agent already running on port 8001 - skipping start." -ForegroundColor Green
  } else {
    Write-Host "[demo] Starting agent in background window..." -ForegroundColor Cyan
    $startScript = Join-Path $PSScriptRoot "start-agent.ps1"
    Start-Process powershell -ArgumentList "-NoExit", "-File", $startScript -WindowStyle Normal
    Wait-ForAgent
  }
}

# -- 2. Reset demo baseline ---------------------------------------------------

if (-not $SkipRemediate) {
  Write-Host ""
  Write-Host "[demo] Resetting buggy baseline before remediation run..." -ForegroundColor Yellow
  try {
    $reset = Invoke-AgentPost "/reset-demo" @{}
    Write-Host "[demo] Reset: $($reset.message)" -ForegroundColor Green
  } catch {
    Write-Host "[demo] Reset skipped (continuing): $($_.Exception.Message)" -ForegroundColor DarkYellow
  }
}

# -- 3. Trigger a real failing request against the app to populate the JSONL
#       log file and obtain a sessionId we can hand to the agent. If the app
#       is not running locally we fall back to letting the agent search recent
#       errors.

$capturedSessionId = $null
if (-not $SkipRemediate) {
  Write-Host ""
  Write-Host "[demo] Hitting the app to generate a failing request + sessionId..." -ForegroundColor Yellow
  try {
    $appBody = @{ name = "Demo Device"; segment = "5G SA"; zipCode = "94105" } | ConvertTo-Json
    Invoke-RestMethod -Uri "$appUrl/api/provision" -Method POST -Body $appBody `
      -ContentType "application/json" -TimeoutSec 10 -ErrorAction Stop | Out-Null
  } catch {
    if ($_.ErrorDetails.Message) {
      try {
        $errObj = $_.ErrorDetails.Message | ConvertFrom-Json
        $capturedSessionId = $errObj.sessionId
        Write-Host "[demo] Captured sessionId: $capturedSessionId" -ForegroundColor Green
      } catch {
        Write-Host "[demo] Could not parse app error body: $($_.ErrorDetails.Message)" -ForegroundColor DarkYellow
      }
    } else {
      Write-Host "[demo] App not reachable on $appUrl -- agent will fall back to recent errors." -ForegroundColor DarkYellow
    }
  }
}

# -- 4. POST /remediate  (full graph) -----------------------------------------

if (-not $SkipRemediate) {
  Write-Header "FLOW 2 - /remediate  (full graph)"
  Write-Host "  triage -> createTicket -> finalize -> pullLogs -> rcaAnalysis ->" -ForegroundColor DarkGray
  Write-Host "  applyFix -> deploySandbox -> verifyScenario -> generateReport -> openPR" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "[demo] Calling POST /remediate (may take 30-90 s) ..." -ForegroundColor Yellow

  $remBody = @{
    segment   = "5G SA"
    zipCode   = "94105"
    errorCode = "COVERAGE_UNAVAILABLE"
    message   = "No 5G SA coverage available in your domestic service area."
  }
  if ($capturedSessionId) { $remBody.sessionId = $capturedSessionId }

  $remResult = Invoke-AgentPost "/remediate" $remBody

  # -- Ticket --
  Write-Host ""
  Write-Host "  --- TICKET ---" -ForegroundColor DarkGray
  Write-Step "ok:"            "$($remResult.ok)"
  Write-Step "sessionId:"     "$($remResult.sessionId)"
  Write-Step "ticket number:" "$($remResult.ticket.number)"
  Write-Step "ticket link:"   "$($remResult.ticket.link)"

  # -- Log evidence --
  if ($remResult.logsContext) {
    Write-Host "  --- LOG EVIDENCE ---" -ForegroundColor DarkGray
    Write-Step "logFile:" "$($remResult.logsContext.logFile)"
    Write-Step "source:"  "$($remResult.logsContext.source)"
    Write-Step "matched:" "$($remResult.logsContext.matched)"
    if ($remResult.logsContext.preview) {
      foreach ($line in $remResult.logsContext.preview) {
        $prefixed = "    | " + $line
        Write-Host $prefixed -ForegroundColor Gray
      }
    }
  }

  # -- RCA --
  Write-Host "  --- RCA ---" -ForegroundColor DarkGray
  $rca = $remResult.rcaResult
  Write-Step "rootCause:"      "$($rca.rootCause)"
  Write-Step "affectedFile:"   "$($rca.affectedFile)"
  Write-Step "fixType:"        "$($rca.fixType)"
  Write-Step "fixDescription:" "$($rca.fixDescription)"
  Write-Step "fixSummary:"     "$($remResult.fixSummary)"

  # -- Sandbox verification --
  Write-Host "  --- SANDBOX VERIFICATION ---" -ForegroundColor DarkGray
  $v = $remResult.verifyResult
  $badge = if ($v.passed) { "[OK] PASSED" } else { "[FAIL] FAILED" }
  Write-Step "result:"     $badge
  Write-Step "method:"     "$($v.method)"
  Write-Step "httpStatus:" "$($v.status)"
  Write-Step "segment:"    "$($v.scenario.segment)"
  Write-Step "zipCode:"    "$($v.scenario.zipCode)"
  Write-Step "testedAt:"   "$($v.testedAt)"

  # -- PR --
  Write-Host "  --- PULL REQUEST ---" -ForegroundColor DarkGray
  if ($remResult.prUrl) {
    Write-Step "PR:" "[OK] $($remResult.prUrl)"
  } elseif ($remResult.prError) {
    Write-Step "PR:" "[FAIL] $($remResult.prError)"
  } else {
    Write-Step "PR:" "(none)"
  }

  # -- Ticket close --
  Write-Host "  --- TICKET CLOSE ---" -ForegroundColor DarkGray
  if ($remResult.ticketClose) {
    $tc = $remResult.ticketClose
    $tcBadge = if ($tc.resolved) { "[OK] RESOLVED" } else { "[INFO] $($tc.action)" }
    Write-Step "result:" $tcBadge
    Write-Step "action:" "$($tc.action)"
    if ($tc.state)  { Write-Step "state:" "$($tc.state)" }
    if ($tc.error)  { Write-Step "error:" "$($tc.error)" }
  } else {
    Write-Step "ticketClose:" "(none)"
  }

  # -- Report preview --
  if ($remResult.report) {
    Write-Host ""
    Write-Host "  --- REMEDIATION REPORT (first 30 lines) ---" -ForegroundColor DarkGray
    $remResult.report -split "`n" | Select-Object -First 30 | ForEach-Object {
      $prefixed = "  | " + $_
      Write-Host $prefixed -ForegroundColor Gray
    }
  }
}

Write-Host ""
Write-Host "[demo] Done." -ForegroundColor Green
