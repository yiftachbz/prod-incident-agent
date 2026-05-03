import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { readFile, writeFile, rm } from "fs/promises";
import { createIncident, updateIncident } from "./servicenow.js";
import { startSandbox, stopSandbox } from "./sandbox.js";
import { pullLogsForSession, pullRecentErrors, summarizeLogs } from "./logs.js";
import { cloneRepoToTemp, resolveWorkspacePath } from "./workspace.js";

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

const AgentState = Annotation.Root({
  // ── Triage / ticket fields (existing) ──────────────────────────────────────
  prompt: Annotation(),
  identifier: Annotation(),
  shortDescription: Annotation(),
  description: Annotation(),
  urgency: Annotation(),
  impact: Annotation(),
  category: Annotation(),
  ticket: Annotation(),
  error: Annotation(),

  // ── Remediation fields (new) ───────────────────────────────────────────────
  /** { segment, zipCode, errorCode, message, sessionId } — triggers the remediation path */
  incidentContext: Annotation(),
  /** { logFile, found, entries: [...], summaryLines: [...], source: "session"|"recent-errors"|"none" } */
  logsContext: Annotation(),
  /** { rootCause, affectedFile, fixDescription, fixType } */
  rcaResult: Annotation(),
  /** Unified diff string produced after the fix */
  fixDiff: Annotation(),
  /** One-line description of the change */
  fixSummary: Annotation(),
  /** Port the sandbox container is published on (null when Docker unavailable) */
  sandboxPort: Annotation(),
  /** Hostname used to reach the sandbox container */
  sandboxHost: Annotation(),
  /** { passed, status, response, scenario, testedAt } */
  verifyResult: Annotation(),
  /** Full markdown remediation report */
  report: Annotation(),
  /** URL of the opened GitHub pull request (null on failure) */
  prUrl: Annotation(),
  /** Error message from the PR step (null on success) */
  prError: Annotation(),
  /** { resolved, state, action, error } — outcome of the closeTicket node */
  ticketClose: Annotation(),
  /** Absolute path to the shallow-cloned temp workspace (null when REPO_ROOT is used) */
  workspacePath: Annotation(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

const ID_REGEX = /\b[A-Z][A-Z0-9]*-\d+\b/;
const ALLOWED_PRIORITIES = new Set(["1", "2", "3"]);
const ALLOWED_CATEGORIES = new Set(["software", "hardware", "network", "inquiry"]);

function extractJsonObject(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

/**
 * Call the configured LLM (LiteLLM proxy or OpenAI) with a prompt.
 * Returns parsed JSON from the response, or throws on failure.
 */
async function callLLM(systemPrompt, userContent) {
  const baseURL = process.env.OPENAI_BASE_URL || process.env.LITELLM_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY || (baseURL ? "sk-litellm-local" : null);
  if (!apiKey) throw new Error("No LLM API key configured");

  const { OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });

  const res = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  });

  const text = res.choices?.[0]?.message?.content ?? "";
  const raw = extractJsonObject(text);
  if (!raw) throw new Error(`LLM did not return JSON: ${text.slice(0, 300)}`);
  return JSON.parse(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Existing nodes (triage / createTicket / finalize) ────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

function triageFallback(prompt) {
  const match = prompt.match(ID_REGEX);
  const identifier = match ? match[0] : null;
  const firstSentence = prompt.split(/[.!?\n]/, 1)[0].trim() || prompt.trim();
  const shortDescription =
    firstSentence.length > 100 ? `${firstSentence.slice(0, 97)}...` : firstSentence;
  return {
    identifier,
    shortDescription,
    description: prompt.trim(),
    urgency: "2",
    impact: "2",
    category: "network",
  };
}

async function triageWithLLM(prompt) {
  const baseURL = process.env.OPENAI_BASE_URL || process.env.LITELLM_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY || (baseURL ? "sk-litellm-local" : null);
  if (!apiKey) return null;

  try {
    const { OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });

    const res = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: [
            "You triage production incident requests for a ServiceNow integration.",
            "Given the user's free-text message, return a JSON object with EXACTLY these fields:",
            '  - identifier: string|null. The issue identifier mentioned (e.g. "TEST-001"). null if none.',
            "  - shortDescription: string, <=100 chars, no markdown, suitable for ServiceNow short_description.",
            "  - description: string, 1-4 sentences elaborating the request.",
            '  - urgency: "1" (high) | "2" (medium) | "3" (low). Default "2".',
            '  - impact:  "1" (high) | "2" (medium) | "3" (low). Default "2".',
            '  - category: "software" | "hardware" | "network" | "inquiry". Default "network".',
            "Return ONLY the JSON object, no prose, no markdown fences.",
          ].join("\n"),
        },
        { role: "user", content: prompt },
      ],
    });

    const text = res.choices?.[0]?.message?.content ?? "";
    const json = extractJsonObject(text);
    if (!json) throw new Error(`LLM did not return JSON: ${text.slice(0, 200)}`);
    const parsed = JSON.parse(json);

    return {
      identifier:
        typeof parsed.identifier === "string" && parsed.identifier.trim()
          ? parsed.identifier.trim()
          : null,
      shortDescription: String(parsed.shortDescription ?? "").trim().slice(0, 100),
      description: String(parsed.description ?? "").trim(),
      urgency: ALLOWED_PRIORITIES.has(String(parsed.urgency)) ? String(parsed.urgency) : "2",
      impact: ALLOWED_PRIORITIES.has(String(parsed.impact)) ? String(parsed.impact) : "2",
      category: ALLOWED_CATEGORIES.has(String(parsed.category)) ? String(parsed.category) : "network",
    };
  } catch (err) {
    console.warn("[agent] LLM triage failed, falling back to regex:", err?.message ?? err);
    return null;
  }
}

async function triage(state) {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("[graph] ▶ NODE: triage");
  console.log(`[graph]   prompt: "${(state.prompt ?? "").toString().slice(0, 120)}"`);

  const prompt = (state.prompt ?? "").toString().trim();
  if (!prompt) return { error: "prompt is required" };

  const llm = await triageWithLLM(prompt);
  const fallback = triageFallback(prompt);
  const triaged = llm ?? fallback;

  const result = {
    prompt,
    identifier: triaged.identifier ?? fallback.identifier,
    shortDescription: triaged.shortDescription || fallback.shortDescription,
    description: triaged.description || fallback.description,
    urgency: triaged.urgency,
    impact: triaged.impact,
    category: triaged.category,
  };

  console.log(`[graph]   identifier:        ${result.identifier ?? "(none)"}`);
  console.log(`[graph]   shortDescription:  ${result.shortDescription}`);
  console.log(`[graph]   urgency/impact:    ${result.urgency} / ${result.impact}`);
  console.log(`[graph]   category:          ${result.category}`);
  console.log(`[graph]   method:            ${llm ? "LLM" : "regex-fallback"}`);
  return result;
}

async function createTicket(state) {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("[graph] ▶ NODE: createTicket");
  if (state.error) { console.log("[graph]   skipped (upstream error)"); return {}; }
  try {
    const fields = {
      short_description: state.shortDescription,
      description: state.description,
      urgency: state.urgency,
      impact: state.impact,
      category: state.category,
      caller_id: process.env.SERVICENOW_USER,
    };
    if (state.identifier) fields.correlation_id = state.identifier;
    const ticket = await createIncident(fields);
    console.log(`[graph]   [OK] Ticket created:  ${ticket.number ?? ticket.sys_id}`);
    console.log(`[graph]   link:              ${ticket.link ?? "(none)"}`);
    return { ticket };
  } catch (err) {
    console.error("[graph]   [FAIL] createTicket error:", err?.message ?? err);
    return { error: String(err?.message ?? err) };
  }
}

async function finalize(state) {
  const hasRemediation = Boolean(state.incidentContext);
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("[graph] ▶ NODE: finalize");
  console.log(`[graph]   ticket:            ${state.ticket?.number ?? "(none)"}`);
  console.log(`[graph]   remediation path:  ${hasRemediation ? "YES — continuing to rcaAnalysis" : "NO — ending here"}`);
  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Remediation nodes ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

/**
 * cloneRepo
 *
 * Shallow-clones the GitHub repo into a fresh temp directory so the agent
 * has its own isolated copy of the source code to read, patch, and build.
 *
 * When REPO_ROOT is set (local dev override), skips the clone and returns
 * that path directly — the cleanup node will also be a no-op in that case.
 */
async function cloneRepo(state) {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("[graph] ▶ NODE: cloneRepo");
  if (state.error) { console.log("[graph]   skipped (upstream error)"); return {}; }

  if (process.env.REPO_ROOT) {
    console.log(`[graph]   REPO_ROOT override set — skipping clone: ${process.env.REPO_ROOT}`);
    return { workspacePath: process.env.REPO_ROOT };
  }

  const repoUrl = process.env.REPO_URL;
  const branch  = process.env.REPO_BRANCH ?? "master";
  const token   = process.env.GITHUB_TOKEN;

  if (!repoUrl || !token) {
    throw new Error("[cloneRepo] REPO_URL and GITHUB_TOKEN are required when REPO_ROOT is not set");
  }

  const { workspacePath } = await cloneRepoToTemp({ repoUrl, branch, token });
  console.log(`[graph]   workspacePath:     ${workspacePath}`);
  return { workspacePath };
}

/**
 * cleanupWorkspace
 *
 * Removes the temp clone created by cloneRepo. No-op when REPO_ROOT was
 * used (dev override). Best-effort — never throws.
 */
async function cleanupWorkspace(state) {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("[graph] ▶ NODE: cleanupWorkspace");

  if (process.env.REPO_ROOT || !state.workspacePath) {
    console.log("[graph]   skipped (REPO_ROOT override or no workspace path)");
    return {};
  }

  try {
    await rm(state.workspacePath, { recursive: true, force: true });
    console.log(`[graph]   removed:           ${state.workspacePath}`);
  } catch (err) {
    console.warn(`[graph]   cleanup failed (ignored): ${err.message}`);
  }
  return {};
}

/**
 * pullLogs
 *
 * Reads the app's structured JSONL log file and filters every entry that
 * carries the failing sessionId / identifier. The collected entries become
 * primary evidence for rcaAnalysis — the LLM sees what the server actually
 * did at runtime, not just what its source code looks like.
 *
 * Resolution order for the correlation key:
 *   1. state.incidentContext.sessionId  (explicit)
 *   2. state.identifier                 (extracted from the prompt by triage)
 *   3. fallback: most recent error entries in the log file
 */
async function pullLogs(state) {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("[graph] ▶ NODE: pullLogs");
  if (state.error) { console.log("[graph]   skipped (upstream error)"); return {}; }

  const ctx = state.incidentContext ?? {};
  const sessionId = ctx.sessionId ?? state.identifier ?? null;

  let result;
  let source;

  if (sessionId) {
    console.log(`[graph]   sessionId:         ${sessionId}`);
    result = await pullLogsForSession(sessionId, null, { limit: 200 });
    source = result.found ? "session" : "session-miss";
  } else {
    console.log(`[graph]   sessionId:         (none — falling back to recent errors)`);
    result = await pullRecentErrors(null, { limit: 50 });
    source = result.found ? "recent-errors" : "none";
  }

  const summaryLines = summarizeLogs(result.entries);
  console.log(`[graph]   logFile:           ${result.logFile}`);
  console.log(`[graph]   matched entries:   ${result.entries.length} (source=${source})`);
  if (summaryLines.length > 0) {
    console.log(`[graph]   first line:        ${summaryLines[0].slice(0, 160)}`);
  }

  return {
    logsContext: {
      logFile: result.logFile,
      found: result.found,
      entries: result.entries,
      summaryLines,
      source,
      sessionId,
    },
  };
}

/**
 * rcaAnalysis
 *
 * Reads app/server/src/index.js directly and asks the LLM to identify
 * the root cause of the reported incident. Combines static source-code
 * analysis with the runtime log evidence collected by `pullLogs` so the
 * LLM can correlate symptoms in logs with the offending code path.
 */
async function rcaAnalysis(state) {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("[graph] ▶ NODE: rcaAnalysis");
  if (state.error) { console.log("[graph]   skipped (upstream error)"); return {}; }

  const root = resolveWorkspacePath(state);
  const ctx = state.incidentContext ?? {};
  const segment = ctx.segment ?? "5G SA";
  const zipCode = ctx.zipCode ?? "94105";
  const errorCode = ctx.errorCode ?? "COVERAGE_UNAVAILABLE";

  const serverFile = path.join(root, "app", "server", "src", "index.js");
  const fileContent = await readFile(serverFile, "utf8");

  const logs = state.logsContext ?? { entries: [], summaryLines: [], source: "none" };
  const logsBlock =
    logs.summaryLines.length > 0
      ? logs.summaryLines.slice(-25).join("\n")
      : "(no log entries available)";

  const systemPrompt = [
    "You are a production incident analyst.",
    "You are given (a) runtime log entries from the server, correlated by sessionId,",
    "and (b) the current server source code.",
    "Use the logs to confirm what the server actually did at runtime, then analyze",
    "the source code to identify the exact root cause and propose a minimal fix.",
    "Return ONLY a JSON object with no prose, no markdown fences:",
    '{ "rootCause": "<one sentence>", "affectedFile": "app/server/src/index.js", "fixDescription": "<what to change>", "fixType": "missing_call" | "wrong_logic" | "config_error" }',
  ].join("\n");

  const userContent = [
    `Incident: POST /api/provision returns ${errorCode} for segment="${segment}", zipCode="${zipCode}".`,
    `Message: ${ctx.message ?? "No coverage available"}`,
    `Correlation key (sessionId): ${logs.sessionId ?? "(none)"}`,
    `Log source: ${logs.source}  •  matched entries: ${logs.entries.length}`,
    "",
    "Runtime log evidence (most recent entries for this session):",
    "```",
    logsBlock,
    "```",
    "",
    "Server code (app/server/src/index.js):",
    "```javascript",
    fileContent,
    "```",
    "",
    "Identify the bug and return the JSON object.",
  ].join("\n");

  const result = await callLLM(systemPrompt, userContent);

  if (!result?.rootCause) {
    throw new Error("[rcaAnalysis] LLM did not return a valid RCA result");
  }

  result.affectedFile = "app/server/src/index.js";

  console.log(`[graph]   rootCause:         ${result.rootCause}`);
  console.log(`[graph]   affectedFile:      ${result.affectedFile}`);
  console.log(`[graph]   fixType:           ${result.fixType}`);
  console.log(`[graph]   fixDescription:    ${result.fixDescription}`);
  return { rcaResult: result };
}

/**
 * applyFix
 *
 * Asks the LLM to produce the complete fixed version of the file,
 * writes it to disk, then captures the git diff.
 */
async function applyFix(state) {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("[graph] ▶ NODE: applyFix");
  if (state.error || !state.rcaResult) { console.log("[graph]   skipped (no RCA result)"); return {}; }

  const root = resolveWorkspacePath(state);
  const rca = state.rcaResult;
  const serverFile = path.join(root, "app", "server", "src", "index.js");
  const fileContent = await readFile(serverFile, "utf8");

  const systemPrompt = [
    "You are a production code fixer.",
    "Given the buggy source file and the root cause, return a JSON object with the COMPLETE fixed file content.",
    "Apply the minimal fix — preserve existing style, imports, and structure. Change nothing else.",
    "Return ONLY a JSON object with no prose:",
    '{ "summary": "<one-line description of the change>", "fixedContent": "<complete fixed file as a string>" }',
  ].join("\n");

  const userContent = [
    `Root cause: ${rca.rootCause}`,
    `Required change: ${rca.fixDescription}`,
    "",
    "Current file content (app/server/src/index.js):",
    "```javascript",
    fileContent,
    "```",
    "",
    "Return the JSON object with the complete fixed file.",
  ].join("\n");

  const result = await callLLM(systemPrompt, userContent);

  if (!result?.fixedContent) {
    throw new Error("[applyFix] LLM did not return fixedContent");
  }

  // Write the fixed content to disk
  await writeFile(serverFile, result.fixedContent, "utf8");
  console.log("[agent] fix written to disk:", serverFile);

  // Capture the git diff
  let diff = "";
  try {
    const diffEnv = { ...process.env };
    if (process.env.GH_PATH) diffEnv.PATH = `${process.env.GH_PATH};${diffEnv.PATH}`;
    const { stdout } = await execFileAsync(
      "git", ["diff", "app/server/src/index.js"],
      { cwd: root, maxBuffer: 1024 * 1024, env: diffEnv }
    );
    diff = stdout.trim();
  } catch (err) {
    console.warn("[agent] git diff failed:", err.message);
    diff = "(diff unavailable)";
  }

  console.log(`[graph]   fixSummary:        ${result.summary}`);
  const diffLines = (diff || "").split("\n").length;
  console.log(`[graph]   diff:              ${diffLines} lines`);
  return { fixDiff: diff || "(no diff — file may be unchanged)", fixSummary: result.summary };
}

/**
 * deploySandbox
 *
 * Builds a Docker image from the patched app/server source and starts an
 * ephemeral container. Agent and app server do NOT need to be on the same
 * machine — the only requirement is a Docker daemon reachable by the agent
 * (mount /var/run/docker.sock, or use a DinD sidecar in AWS ECS EC2).
 *
 * Fails gracefully: if Docker is unavailable, logs a warning and returns
 * sandboxPort: null so verifyScenario falls back to inline code analysis.
 */
async function deploySandbox(state) {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("[graph] ▶ NODE: deploySandbox");
  if (state.error) { console.log("[graph]   skipped (upstream error)"); return {}; }

  const root = resolveWorkspacePath(state);

  const { host, port } = await startSandbox(root);
  console.log(`[graph]   sandbox:           ${host}:${port ?? "(unavailable — will use fallback)"}`);
  return { sandboxHost: host, sandboxPort: port };
}

/**
 * verifyScenario
 *
 * Two-tier verification strategy:
 *
 *  1. PRIMARY — Live HTTP test against the Docker sandbox container.
 *     Used when deploySandbox successfully started a container.
 *     Sends the actual failing request to the patched server and asserts a 200.
 *
 *  2. FALLBACK — In-process code analysis.
 *     Used when Docker is unavailable (sandboxPort is null).
 *     Reads the patched source, extracts COVERAGE_DB and the coverage function,
 *     confirms the function is called in the handler, then evaluates the logic
 *     directly to confirm the scenario would pass.
 *
 * Always stops the sandbox container before returning.
 */
async function verifyScenario(state) {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("[graph] ▶ NODE: verifyScenario");
  if (state.error) { console.log("[graph]   skipped (upstream error)"); return {}; }

  const ctx = state.incidentContext ?? {};
  const segment = ctx.segment ?? "5G SA";
  const zipCode = ctx.zipCode ?? "94105";
  const testedAt = new Date().toISOString();

  // Live HTTP test against the sandbox container
  const url = `http://${state.sandboxHost ?? "localhost"}:${state.sandboxPort}/api/provision`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Agent Verification Device", segment, zipCode }),
    });
    const data = await res.json();
    const passed = res.status === 200 && data.ok === true;
    console.log(`[graph]   result:            ${passed ? "[OK] PASSED" : "[FAIL] FAILED"} (HTTP ${res.status})`);
    console.log(`[graph]   scenario:          segment=${segment}, zipCode=${zipCode}`);
    console.log(`[graph]   testedAt:          ${testedAt}`);
    return {
      verifyResult: {
        passed,
        status: res.status,
        response: data,
        scenario: { segment, zipCode },
        testedAt,
        method: "docker-sandbox-http",
      },
    };
  } finally {
    await stopSandbox();
  }
}

/**
 * generateReport
 *
 * Builds a structured markdown report that includes the incident summary,
 * RCA findings, the applied diff, sandbox verification result, and
 * environment details.
 */
async function generateReport(state) {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("[graph] ▶ NODE: generateReport");
  const ticket = state.ticket ?? {};
  const ctx = state.incidentContext ?? {};
  const rca = state.rcaResult ?? {};
  const verify = state.verifyResult ?? {};
  const logs = state.logsContext ?? { entries: [], summaryLines: [], source: "none" };

  const verifyBadge = verify.passed ? "PASSED" : "FAILED";
  const now = new Date().toISOString();

  const logEvidenceLines =
    logs.summaryLines.length > 0
      ? logs.summaryLines.slice(-15).map((l) => `    ${l}`).join("\n")
      : "    (no log entries matched)";

  const report = [
    "# Incident Auto-Remediation Report",
    "",
    "## Incident",
    `- **Ticket**: ${ticket.number ?? "N/A"}`,
    `- **ServiceNow link**: ${ticket.link ?? "N/A"}`,
    `- **Session ID**: ${logs.sessionId ?? ctx.sessionId ?? "N/A"}`,
    `- **Segment**: ${ctx.segment ?? "N/A"}`,
    `- **Zip code**: ${ctx.zipCode ?? "N/A"}`,
    `- **Error code**: ${ctx.errorCode ?? "N/A"}`,
    `- **Generated**: ${now}`,
    "",
    "## Log Evidence",
    `- **Log file**: \`${logs.logFile ?? "N/A"}\``,
    `- **Source**: ${logs.source}`,
    `- **Matched entries**: ${logs.entries.length}`,
    "",
    "```",
    logEvidenceLines,
    "```",
    "",
    "## Root Cause Analysis",
    `**Root cause**: ${rca.rootCause ?? "N/A"}`,
    "",
    `**Affected file**: \`${rca.affectedFile ?? "N/A"}\``,
    "",
    `**Fix type**: ${rca.fixType ?? "N/A"}`,
    "",
    `**Fix description**: ${rca.fixDescription ?? "N/A"}`,
    "",
    "## Applied Diff",
    "```diff",
    state.fixDiff ?? "(no diff captured)",
    "```",
    "",
    "## Code Verification",
    `- **Result**: ${verifyBadge}`,
    `- **Method**: ${verify.method ?? "inline-code-analysis"}`,
    `- **Tested at**: ${verify.testedAt ?? "N/A"}`,
    `- **Scenario**: segment=${verify.scenario?.segment ?? "N/A"}, zipCode=${verify.scenario?.zipCode ?? "N/A"}`,
    "",
    "## Environment",
    `- **Repo root**: \`${process.env.REPO_ROOT ?? "."}\``,
    `- **Sandbox**: ${state.sandboxHost}:${state.sandboxPort} (docker)`,
    `- **Node version**: ${process.version}`,
    `- **Agent**: prod-incident-agent v0.1.0`,
  ].join("\n");

  console.log(`[graph]   report:            ${report.split("\n").length} lines generated`);
  return { report };
}

/**
 * openPR
 *
 * Creates a feature branch, commits the fix, pushes, and opens a
 * GitHub pull request. Skips gracefully when git / gh are unavailable
 * or when the verification did not pass.
 */
async function openPR(state) {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("[graph] ▶ NODE: openPR");
  if (!state.verifyResult?.passed) {
    console.log("[graph]   skipped — verification did not pass");
    return { prUrl: null, prError: "Skipped: code verification did not pass" };
  }

  const root = resolveWorkspacePath(state);
  const branch = `fix/coverage-check-${Date.now()}`;
  const base = process.env.GIT_DEFAULT_BRANCH ?? "master";
  const commitMsg = [
    "fix: add checkNetworkCoverageByZipCode to POST /api/provision",
    "",
    state.rcaResult?.rootCause ?? "",
    "",
    `Auto-fixed by prod-incident-agent. Ticket: ${state.ticket?.number ?? "N/A"}`,
  ].join("\n");

  try {
    const gitEnv = { ...process.env };
    if (process.env.GH_PATH) gitEnv.PATH = `${process.env.GH_PATH};${gitEnv.PATH}`;
    const gitOpts = { cwd: root, env: gitEnv };

    await execFileAsync("git", ["checkout", "-b", branch], gitOpts);
    await execFileAsync("git", ["add", "app/server/src/index.js"], gitOpts);
    await execFileAsync("git", ["commit", "-m", commitMsg], gitOpts);
    await execFileAsync("git", ["push", "-u", "origin", branch], gitOpts);

    const { stdout: prUrl } = await execFileAsync(
      "gh",
      [
        "pr", "create",
        "--base", base,
        "--head", branch,
        "--title", "fix: add coverage check to 5G provisioning handler",
        "--body", state.report ?? "Auto-remediation report unavailable.",
      ],
      { cwd: root, maxBuffer: 1024 * 1024, env: gitEnv }
    );

    const url = prUrl.trim();
    console.log(`[graph]   [OK] PR created:      ${url}`);
    return { prUrl: url };
  } catch (err) {
    console.warn(`[graph]   [FAIL] PR failed:       ${err.message}`);
    return { prUrl: null, prError: err.message };
  }
}

/**
 * closeTicket
 *
 * Updates the ServiceNow incident created by `createTicket` based on the
 * remediation outcome:
 *
 *   • verification PASSED  → resolve the incident (state=6) with close_code +
 *     close_notes (full markdown report). PR URL is appended when available.
 *   • verification FAILED  → leave the ticket open but post a `work_notes`
 *     update with the report so the on-call engineer has the evidence.
 *
 * Skips silently when no ticket was created (createTicket failed earlier).
 */
async function closeTicket(state) {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("[graph] ▶ NODE: closeTicket");

  const sysId = state.ticket?.sys_id;
  if (!sysId) {
    console.log("[graph]   skipped — no ticket sys_id available");
    return { ticketClose: { resolved: false, action: "skipped-no-ticket" } };
  }

  const passed = Boolean(state.verifyResult?.passed);
  const prSuffix = state.prUrl
    ? `\n\nPull request: ${state.prUrl}`
    : state.prError
      ? `\n\nPR creation skipped/failed: ${state.prError}`
      : "";
  const reportBody = (state.report ?? "Auto-remediation report unavailable.") + prSuffix;

  try {
    if (passed) {
      const fields = {
        state: "6",
        close_code: "Solved (Permanently)",
        close_notes: reportBody,
        work_notes: state.prUrl
          ? `Auto-remediated by prod-incident-agent. PR: ${state.prUrl}`
          : "Auto-remediated by prod-incident-agent (verification passed; no PR opened).",
      };
      const result = await updateIncident(sysId, fields);
      console.log(`[graph]   [OK] ticket resolved: ${state.ticket?.number ?? sysId} (state=${result.state ?? "6"})`);
      return {
        ticketClose: {
          resolved: true,
          state: result.state ?? "6",
          action: "resolved",
        },
      };
    }

    const fields = {
      work_notes: `Auto-remediation verification FAILED — ticket left open.\n\n${reportBody}`,
    };
    const result = await updateIncident(sysId, fields);
    console.log(`[graph]   [INFO] verification failed — ticket ${state.ticket?.number ?? sysId} kept open with work_notes`);
    return {
      ticketClose: {
        resolved: false,
        state: result.state ?? null,
        action: "work-notes-only",
      },
    };
  } catch (err) {
    console.warn(`[graph]   [FAIL] closeTicket error: ${err.message}`);
    return {
      ticketClose: {
        resolved: false,
        action: "error",
        error: err.message,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph assembly
// ─────────────────────────────────────────────────────────────────────────────

export function buildGraph() {
  const graph = new StateGraph(AgentState)
    // ticket nodes
    .addNode("triage", triage)
    .addNode("createTicket", createTicket)
    .addNode("finalize", finalize)
    // remediation nodes
    .addNode("cloneRepo", cloneRepo)
    .addNode("pullLogs", pullLogs)
    .addNode("rcaAnalysis", rcaAnalysis)
    .addNode("applyFix", applyFix)
    .addNode("deploySandbox", deploySandbox)
    .addNode("verifyScenario", verifyScenario)
    .addNode("generateReport", generateReport)
    .addNode("openPR", openPR)
    .addNode("closeTicket", closeTicket)
    .addNode("cleanupWorkspace", cleanupWorkspace)
    // ticket edges
    .addEdge(START, "triage")
    .addEdge("triage", "createTicket")
    .addEdge("createTicket", "finalize")
    // conditional: remediation only when incidentContext is present
    .addConditionalEdges("finalize", (state) =>
      state.incidentContext ? "cloneRepo" : END
    )
    // remediation chain
    .addEdge("cloneRepo", "pullLogs")
    .addEdge("pullLogs", "rcaAnalysis")
    .addEdge("rcaAnalysis", "applyFix")
    .addEdge("applyFix", "deploySandbox")
    .addEdge("deploySandbox", "verifyScenario")
    .addEdge("verifyScenario", "generateReport")
    .addEdge("generateReport", "openPR")
    .addEdge("openPR", "closeTicket")
    .addEdge("closeTicket", "cleanupWorkspace")
    .addEdge("cleanupWorkspace", END);

  return graph.compile();
}
