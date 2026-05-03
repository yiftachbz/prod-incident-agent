import "dotenv/config";
import express from "express";
import { execFile } from "child_process";
import { promisify } from "util";
import { rm } from "fs/promises";
import { buildGraph } from "./graph.js";
import { servicenowConfig } from "./servicenow.js";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT ?? 8001);

const app = express();
app.use(express.json());

let graph;
try {
  servicenowConfig();
  graph = buildGraph();
} catch (err) {
  console.error("[agent] startup error:", err?.message ?? err);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  const cfg = servicenowConfig();
  const baseURL = process.env.OPENAI_BASE_URL || process.env.LITELLM_BASE_URL || null;
  const hasKey = Boolean(process.env.OPENAI_API_KEY) || Boolean(baseURL);
  res.json({
    ok: true,
    service: "agent",
    instance: cfg.instance,
    llm: hasKey
      ? {
          provider: baseURL ? "openai-compatible" : "openai",
          baseURL: baseURL ?? "https://api.openai.com/v1",
          model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
        }
      : "template-fallback",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /remediate  — full auto-remediation flow
//
// Body (all fields optional — sensible defaults are applied):
//   {
//     "segment":      "5G SA",
//     "zipCode":      "94105",
//     "errorCode":    "COVERAGE_UNAVAILABLE",
//     "message":      "No 5G SA coverage available in your domestic service area.",
//     "sessionId":    "SES-1730283301123-a1b2",   // correlation key emitted by
//                                                 // the app server in the failing
//                                                 // response + JSONL log file
//     "prompt":       "Custom ServiceNow ticket prompt (auto-generated when omitted)"
//   }
//
// Response:
//   {
//     "ok": true,
//     "sessionId":     "SES-...",
//     "ticket":        { sys_id, number, link },
//     "logsContext":   { logFile, source, matched, preview: [string, ...] },
//     "rcaResult":     { rootCause, affectedFile, fixDescription, fixType },
//     "fixSummary":    "one-line description of the change",
//     "verifyResult":  { passed, status, response, scenario, testedAt },
//     "report":        "# Incident Auto-Remediation Report\n...",
//     "prUrl":         "https://github.com/..."   (null if PR creation skipped/failed),
//     "ticketClose":   { resolved, state, action, error? }   // outcome of the
//                                                            // ServiceNow update
//   }
// ─────────────────────────────────────────────────────────────────────────────

app.post("/remediate", async (req, res) => {
  const {
    segment = "5G SA",
    zipCode = "94105",
    errorCode = "COVERAGE_UNAVAILABLE",
    message = "No coverage available",
    sessionId = null,
    prompt: customPrompt,
  } = req.body ?? {};

  const sessionTag = sessionId ? ` (sessionId=${sessionId})` : "";
  const prompt =
    customPrompt ||
    `Production incident${sessionTag}: ${errorCode} on POST /api/provision. ` +
      `Network segment: ${segment}, zip code: ${zipCode}. ` +
      `Error: ${message}. Auto-remediation requested.`;

  console.log(`[agent] /remediate triggered — segment=${segment}, zipCode=${zipCode}, sessionId=${sessionId ?? "(none)"}`);

  let result;
  try {
    result = await graph.invoke({
      prompt,
      incidentContext: { segment, zipCode, errorCode, message, sessionId },
    });
  } catch (err) {
    console.error("[agent] remediation error:", err);
    // Best-effort cleanup of temp clone if the graph threw before cleanupWorkspace ran.
    if (err?._workspacePath && !process.env.REPO_ROOT) {
      rm(err._workspacePath, { recursive: true, force: true }).catch(() => {});
    }
    return res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  } finally {
    // Defensive cleanup: if the graph result carries a workspacePath that was
    // clone-created (REPO_ROOT unset) and the cleanupWorkspace node somehow
    // did not remove it, remove it here.
    if (result?.workspacePath && !process.env.REPO_ROOT) {
      rm(result.workspacePath, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (result.error) {
    return res.status(502).json({ ok: false, error: result.error });
  }

  const logs = result.logsContext ?? null;
  return res.json({
    ok: true,
    sessionId: logs?.sessionId ?? sessionId ?? null,
    ticket: result.ticket,
    logsContext: logs
      ? {
          logFile: logs.logFile,
          source: logs.source,
          matched: logs.entries?.length ?? 0,
          preview: logs.summaryLines?.slice(-10) ?? [],
        }
      : null,
    rcaResult: result.rcaResult,
    fixSummary: result.fixSummary,
    verifyResult: result.verifyResult,
    report: result.report,
    prUrl: result.prUrl ?? null,
    prError: result.prError ?? null,
    ticketClose: result.ticketClose ?? null,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /reset-demo  — resets app/server/src/index.js to the committed (buggy)
// baseline so the remediation demo can be run repeatedly.
// ─────────────────────────────────────────────────────────────────────────────

app.post("/reset-demo", async (_req, res) => {
  const root = process.env.REPO_ROOT ?? ".";
  try {
    await execFileAsync(
      "git", ["checkout", "app/server/src/index.js"],
      { cwd: root }
    );
    console.log("[agent] demo reset: app/server/src/index.js restored to baseline");
    return res.json({ ok: true, message: "app/server/src/index.js reset to buggy baseline" });
  } catch (err) {
    console.error("[agent] demo reset failed:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[agent] listening on http://localhost:${PORT}`);
  console.log(`[agent] ServiceNow instance: ${servicenowConfig().instance}`);
  if (process.env.REPO_ROOT) {
    console.log(`[agent] repo source: REPO_ROOT override → ${process.env.REPO_ROOT}`);
  } else {
    console.log(`[agent] repo source: git clone → ${process.env.REPO_URL ?? "(REPO_URL unset)"} (branch: ${process.env.REPO_BRANCH ?? "master"})`);
  }
  console.log(`[agent] app base URL: ${process.env.APP_BASE_URL ?? "(APP_BASE_URL unset)"}`);
});
