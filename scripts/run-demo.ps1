# ─────────────────────────────────────────────────────────────────────────────
# run-demo.ps1  -  Runs the full prod-incident-agent demonstration.
#
# Usage:
#   .\scripts\run-demo.ps1
#   .\scripts\run-demo.ps1 -SkipRemediate  # skip the /remediate step
#   .\scripts\run-demo.ps1 -NoStart        # assume agent is already running
# ─────────────────────────────────────────────────────────────────────────────
param(
  [switch]$SkipRemediate,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$agentUrl = "http://localhost:8001"

# ── helpers ──────────────────────────────────────────────────────────────────

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

# ── 1. Start agent ────────────────────────────────────────────────────────────

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

# ── 2. Reset demo baseline ────────────────────────────────────────────────────

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

# ── 4. POST /remediate  (full graph) ──────────────────────────────────────────

if (-not $SkipRemediate) {
  Write-Header "FLOW 2 - /remediate  (full graph)"
  Write-Host "  triage -> createTicket -> finalize -> rcaAnalysis ->" -ForegroundColor DarkGray
  Write-Host "  applyFix -> deploySandbox -> verifyScenario -> generateReport -> openPR" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "[demo] Calling POST /remediate (may take 30-90 s) ..." -ForegroundColor Yellow

  $remResult = Invoke-AgentPost "/remediate" @{
    segment   = "5G SA"
    zipCode   = "94105"
    errorCode = "COVERAGE_UNAVAILABLE"
    message   = "No 5G SA coverage available in your domestic service area."
  }

  # ── Ticket ──
  Write-Host ""
  Write-Host "  --- TICKET ---" -ForegroundColor DarkGray
  Write-Step "ok:"            "$($remResult.ok)"
  Write-Step "ticket number:" "$($remResult.ticket.number)"
  Write-Step "ticket link:"   "$($remResult.ticket.link)"

  # ── RCA ──
  Write-Host "  --- RCA ---" -ForegroundColor DarkGray
  $rca = $remResult.rcaResult
  Write-Step "rootCause:"      "$($rca.rootCause)"
  Write-Step "affectedFile:"   "$($rca.affectedFile)"
  Write-Step "fixType:"        "$($rca.fixType)"
  Write-Step "fixDescription:" "$($rca.fixDescription)"
  Write-Step "fixSummary:"     "$($remResult.fixSummary)"

  # ── Sandbox verification ──
  Write-Host "  --- SANDBOX VERIFICATION ---" -ForegroundColor DarkGray
  $v = $remResult.verifyResult
  $badge = if ($v.passed) { "[OK] PASSED" } else { "[FAIL] FAILED" }
  Write-Step "result:"     $badge
  Write-Step "method:"     "$($v.method)"
  Write-Step "httpStatus:" "$($v.status)"
  Write-Step "segment:"    "$($v.scenario.segment)"
  Write-Step "zipCode:"    "$($v.scenario.zipCode)"
  Write-Step "testedAt:"   "$($v.testedAt)"

  # ── PR ──
  Write-Host "  --- PULL REQUEST ---" -ForegroundColor DarkGray
  if ($remResult.prUrl) {
    Write-Step "PR:" "[OK] $($remResult.prUrl)"
  } elseif ($remResult.prError) {
    Write-Step "PR:" "[FAIL] $($remResult.prError)"
  } else {
    Write-Step "PR:" "(none)"
  }

  # ── Report preview ──
  if ($remResult.report) {
    Write-Host ""
    Write-Host "  --- REMEDIATION REPORT (first 30 lines) ---" -ForegroundColor DarkGray
    $remResult.report -split "`n" | Select-Object -First 30 | ForEach-Object {
      Write-Host "  | $_" -ForegroundColor Gray
    }
  }
}

Write-Host ""
Write-Host "[demo] Done." -ForegroundColor Green
