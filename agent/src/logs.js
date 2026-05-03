/**
 * Log retrieval for the remediation agent.
 *
 * Fetches structured log entries from the app server's authenticated
 * GET /api/_logs endpoint instead of reading the JSONL file directly.
 * This decouples the agent from the app's filesystem.
 *
 * Required env vars:
 *   APP_BASE_URL  — base URL of the running app server, e.g. http://localhost:3001
 *   LOGS_TOKEN    — shared secret sent as X-Logs-Token header
 */

/**
 * Pull every log entry that matches a sessionId by calling the app's
 * /api/_logs endpoint.
 *
 * The repoRoot parameter is kept for call-site compatibility but ignored.
 *
 * @param {string} sessionId  e.g. "SES-1730283301123-a1b2"
 * @param {string} _unusedRoot  ignored (kept for signature compat)
 * @param {object} [opts]
 * @param {number} [opts.limit=200] cap on number of returned entries
 * @returns {Promise<{ logFile: string, found: boolean, entries: Array<object> }>}
 */
export async function pullLogsForSession(sessionId, _unusedRoot, opts = {}) {
  const limit = opts.limit ?? 200;
  const baseUrl = process.env.APP_BASE_URL;
  const token = process.env.LOGS_TOKEN;
  const logFile = `remote://${baseUrl ?? "(APP_BASE_URL unset)"}/api/_logs`;

  if (!baseUrl || !token) {
    console.warn("[logs] APP_BASE_URL or LOGS_TOKEN not set — skipping log fetch");
    return { logFile, found: false, entries: [] };
  }

  const url = `${baseUrl}/api/_logs?${new URLSearchParams({
    ...(sessionId ? { sessionId } : {}),
    limit: String(limit),
  })}`;

  try {
    const res = await fetch(url, {
      headers: { "X-Logs-Token": token },
    });
    if (!res.ok) {
      console.warn(`[logs] /api/_logs responded ${res.status} — skipping log fetch`);
      return { logFile, found: false, entries: [] };
    }
    const body = await res.json();
    return { logFile, found: body.found ?? false, entries: body.entries ?? [] };
  } catch (err) {
    console.warn("[logs] fetch error:", err.message);
    return { logFile, found: false, entries: [] };
  }
}

/**
 * Pull the most recent N error entries from the log when no sessionId
 * is available — useful as a fallback so RCA still has evidence to work with.
 *
 * The repoRoot parameter is kept for call-site compatibility but ignored.
 */
export async function pullRecentErrors(_unusedRoot, opts = {}) {
  const limit = opts.limit ?? 50;
  const baseUrl = process.env.APP_BASE_URL;
  const token = process.env.LOGS_TOKEN;
  const logFile = `remote://${baseUrl ?? "(APP_BASE_URL unset)"}/api/_logs/recent-errors`;

  if (!baseUrl || !token) {
    console.warn("[logs] APP_BASE_URL or LOGS_TOKEN not set — skipping recent-errors fetch");
    return { logFile, found: false, entries: [] };
  }

  const url = `${baseUrl}/api/_logs/recent-errors?${new URLSearchParams({ limit: String(limit) })}`;

  try {
    const res = await fetch(url, {
      headers: { "X-Logs-Token": token },
    });
    if (!res.ok) {
      console.warn(`[logs] /api/_logs/recent-errors responded ${res.status} — skipping`);
      return { logFile, found: false, entries: [] };
    }
    const body = await res.json();
    return { logFile, found: body.found ?? false, entries: body.entries ?? [] };
  } catch (err) {
    console.warn("[logs] fetch error:", err.message);
    return { logFile, found: false, entries: [] };
  }
}

/**
 * Render a compact summary of log entries for inclusion in LLM prompts
 * and the markdown remediation report. Truncates each `ctx` field to keep
 * token usage bounded.
 */
export function summarizeLogs(entries, { maxCtxChars = 400 } = {}) {
  return entries.map((e) => {
    const ctx = e.ctx ? JSON.stringify(e.ctx) : "";
    const ctxShort = ctx.length > maxCtxChars ? ctx.slice(0, maxCtxChars) + "…" : ctx;
    return `[${e.ts}] ${e.level.toUpperCase()} ${e.route} — ${e.msg} ${ctxShort}`.trim();
  });
}
