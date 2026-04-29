import "dotenv/config";
import express from "express";
import { execFile } from "child_process";
import { promisify } from "util";
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
// POST /run  — simple ticket creation (existing flow)
// ─────────────────────────────────────────────────────────────────────────────

app.post("/run", async (req, res) => {
  const prompt = (req.body?.prompt ?? "").toString().trim();
  if (!prompt) {
    return res.status(400).json({ ok: false, error: "Missing 'prompt' in request body" });
  }

  try {
    const result = await graph.invoke({ prompt });
    if (result.error) {
      return res.status(502).json({ ok: false, error: result.error });
    }
    return res.json({
      ok: true,
      prompt: result.prompt,
      identifier: result.identifier,
      shortDescription: result.shortDescription,
      ticket: result.ticket,
    });
  } catch (err) {
    console.error("[agent] graph error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
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
//     "prompt":       "Custom ServiceNow ticket prompt (auto-generated when omitted)"
//   }
//
// Response:
//   {
//     "ok": true,
//     "ticket":        { sys_id, number, link },
//     "rcaResult":     { rootCause, affectedFile, fixDescription, fixType },
//     "fixSummary":    "one-line description of the change",
//     "verifyResult":  { passed, status, response, scenario, testedAt },
//     "report":        "# Incident Auto-Remediation Report\n...",
//     "prUrl":         "https://github.com/..."   (null if PR creation skipped/failed)
//   }
// ─────────────────────────────────────────────────────────────────────────────

app.post("/remediate", async (req, res) => {
  const {
    segment = "5G SA",
    zipCode = "94105",
    errorCode = "COVERAGE_UNAVAILABLE",
    message = "No coverage available",
    prompt: customPrompt,
  } = req.body ?? {};

  const prompt =
    customPrompt ||
    `Production incident: ${errorCode} on POST /api/provision. ` +
      `Network segment: ${segment}, zip code: ${zipCode}. ` +
      `Error: ${message}. Auto-remediation requested.`;

  console.log(`[agent] /remediate triggered — segment=${segment}, zipCode=${zipCode}`);

  try {
    const result = await graph.invoke({
      prompt,
      incidentContext: { segment, zipCode, errorCode, message },
    });

    if (result.error) {
      return res.status(502).json({ ok: false, error: result.error });
    }

    return res.json({
      ok: true,
      ticket: result.ticket,
      rcaResult: result.rcaResult,
      fixSummary: result.fixSummary,
      verifyResult: result.verifyResult,
      report: result.report,
      prUrl: result.prUrl ?? null,
      prError: result.prError ?? null,
    });
  } catch (err) {
    console.error("[agent] remediation error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
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
  console.log(`[agent] repo root: ${process.env.REPO_ROOT ?? "(cwd)"}`);
});
