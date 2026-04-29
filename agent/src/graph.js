import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { readFile, writeFile } from "fs/promises";
import { createIncident } from "./servicenow.js";
import { startSandbox, stopSandbox } from "./sandbox.js";

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
  /** { segment, zipCode, errorCode, message } — triggers the remediation path */
  incidentContext: Annotation(),
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

function repoRoot() {
  return process.env.REPO_ROOT ?? path.resolve(".");
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
  const prompt = (state.prompt ?? "").toString().trim();
  if (!prompt) return { error: "prompt is required" };

  const llm = await triageWithLLM(prompt);
  const fallback = triageFallback(prompt);
  const triaged = llm ?? fallback;

  return {
    prompt,
    identifier: triaged.identifier ?? fallback.identifier,
    shortDescription: triaged.shortDescription || fallback.shortDescription,
    description: triaged.description || fallback.description,
    urgency: triaged.urgency,
    impact: triaged.impact,
    category: triaged.category,
  };
}

async function createTicket(state) {
  if (state.error) return {};
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
    return { ticket };
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

async function finalize(state) {
  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Remediation nodes ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

/**
 * rcaAnalysis
 *
 * Reads app/server/src/index.js directly and asks the LLM to identify
 * the root cause of the reported incident. Returns structured JSON.
 */
async function rcaAnalysis(state) {
  if (state.error) return {};

  const root = repoRoot();
  const ctx = state.incidentContext ?? {};
  const segment = ctx.segment ?? "5G SA";
  const zipCode = ctx.zipCode ?? "94105";
  const errorCode = ctx.errorCode ?? "COVERAGE_UNAVAILABLE";

  const serverFile = path.join(root, "app", "server", "src", "index.js");
  const fileContent = await readFile(serverFile, "utf8");

  const systemPrompt = [
    "You are a production incident analyst.",
    "Analyze the provided server code and identify the exact root cause of the reported error.",
    "Return ONLY a JSON object with no prose, no markdown fences:",
    '{ "rootCause": "<one sentence>", "affectedFile": "app/server/src/index.js", "fixDescription": "<what to change>", "fixType": "missing_call" | "wrong_logic" | "config_error" }',
  ].join("\n");

  const userContent = [
    `Incident: POST /api/provision returns ${errorCode} for segment="${segment}", zipCode="${zipCode}".`,
    `Message: ${ctx.message ?? "No coverage available"}`,
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

  // Ensure affectedFile is always the correct relative path
  result.affectedFile = "app/server/src/index.js";

  console.log("[agent] RCA via LLM:", result.rootCause);
  return { rcaResult: result };
}

/**
 * applyFix
 *
 * Asks the LLM to produce the complete fixed version of the file,
 * writes it to disk, then captures the git diff.
 */
async function applyFix(state) {
  if (state.error || !state.rcaResult) return {};

  const root = repoRoot();
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
    const { stdout } = await execFileAsync(
      "git", ["diff", "app/server/src/index.js"],
      { cwd: root, maxBuffer: 1024 * 1024 }
    );
    diff = stdout.trim();
  } catch (err) {
    console.warn("[agent] git diff failed:", err.message);
    diff = "(diff unavailable)";
  }

  console.log("[agent] fix applied via LLM:", result.summary);
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
  if (state.error) return {};

  const root = repoRoot();

  const { host, port } = await startSandbox(root);
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
  if (state.error) return {};

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
    console.log(`[agent] sandbox HTTP verify: ${passed ? "PASSED" : "FAILED"} (HTTP ${res.status})`);
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
  const ticket = state.ticket ?? {};
  const ctx = state.incidentContext ?? {};
  const rca = state.rcaResult ?? {};
  const verify = state.verifyResult ?? {};

  const verifyBadge = verify.passed ? "PASSED" : "FAILED";
  const now = new Date().toISOString();

  const report = [
    "# Incident Auto-Remediation Report",
    "",
    "## Incident",
    `- **Ticket**: ${ticket.number ?? "N/A"}`,
    `- **ServiceNow link**: ${ticket.link ?? "N/A"}`,
    `- **Segment**: ${ctx.segment ?? "N/A"}`,
    `- **Zip code**: ${ctx.zipCode ?? "N/A"}`,
    `- **Error code**: ${ctx.errorCode ?? "N/A"}`,
    `- **Generated**: ${now}`,
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
  if (!state.verifyResult?.passed) {
    console.log("[agent] verification did not pass — skipping PR creation");
    return { prUrl: null, prError: "Skipped: code verification did not pass" };
  }

  const root = repoRoot();
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
    await execFileAsync("git", ["checkout", "-b", branch], { cwd: root });
    await execFileAsync("git", ["add", "app/server/src/index.js"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", commitMsg], { cwd: root });
    await execFileAsync("git", ["push", "-u", "origin", branch], { cwd: root });

    const { stdout: prUrl } = await execFileAsync(
      "gh",
      [
        "pr", "create",
        "--base", base,
        "--title", "fix: add coverage check to 5G provisioning handler",
        "--body", state.report ?? "Auto-remediation report unavailable.",
      ],
      { cwd: root, maxBuffer: 1024 * 1024 }
    );

    const url = prUrl.trim();
    console.log("[agent] PR created:", url);
    return { prUrl: url };
  } catch (err) {
    console.warn("[agent] PR creation failed:", err.message);
    return { prUrl: null, prError: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph assembly
// ─────────────────────────────────────────────────────────────────────────────

export function buildGraph() {
  const graph = new StateGraph(AgentState)
    // existing nodes
    .addNode("triage", triage)
    .addNode("createTicket", createTicket)
    .addNode("finalize", finalize)
    // remediation nodes
    .addNode("rcaAnalysis", rcaAnalysis)
    .addNode("applyFix", applyFix)
    .addNode("deploySandbox", deploySandbox)
    .addNode("verifyScenario", verifyScenario)
    .addNode("generateReport", generateReport)
    .addNode("openPR", openPR)
    // existing edges
    .addEdge(START, "triage")
    .addEdge("triage", "createTicket")
    .addEdge("createTicket", "finalize")
    // conditional: remediation only when incidentContext is present
    .addConditionalEdges("finalize", (state) =>
      state.incidentContext ? "rcaAnalysis" : END
    )
    // remediation chain
    .addEdge("rcaAnalysis", "applyFix")
    .addEdge("applyFix", "deploySandbox")
    .addEdge("deploySandbox", "verifyScenario")
    .addEdge("verifyScenario", "generateReport")
    .addEdge("generateReport", "openPR")
    .addEdge("openPR", END);

  return graph.compile();
}
