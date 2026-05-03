/**
 * Structured session logger.
 *
 * Pattern:
 *   - One JSON object per line (JSON Lines / NDJSON) — easy to grep, tail,
 *     ship to ELK/CloudWatch/Loki, and consume programmatically.
 *   - Every line carries a `sessionId` so a downstream agent can pull every
 *     event for a single failing request by grepping for the id.
 *   - Schema:
 *       {
 *         "ts":        ISO-8601 timestamp,
 *         "level":     "debug" | "info" | "warn" | "error",
 *         "sessionId": "SES-<ms>-<rand>",
 *         "route":     "<METHOD> <path>",   // e.g. "POST /api/provision"
 *         "msg":       short human-readable label,
 *         "ctx":       arbitrary JSON-safe object with the event payload
 *       }
 *
 * Storage:
 *   - Default file: <repoRoot>/app/server/logs/server.jsonl
 *   - Override with LOG_PATH env var.
 *   - Directory is created on demand.
 *   - In Docker the file lives at /app/logs/server.jsonl and should be mounted
 *     as a volume so the agent (or a log shipper) can read it.
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const DEFAULT_LOG_PATH = path.resolve("logs", "server.jsonl");
const LOG_PATH = process.env.LOG_PATH
  ? path.resolve(process.env.LOG_PATH)
  : DEFAULT_LOG_PATH;

fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

const stream = fs.createWriteStream(LOG_PATH, { flags: "a" });

stream.on("error", (err) => {
  console.error(`[logger] write stream error for ${LOG_PATH}:`, err.message);
});

/** Generates a session id of the form SES-<ms>-<6 hex>. */
export function newSessionId() {
  return `SES-${Date.now()}-${randomBytes(3).toString("hex")}`;
}

/**
 * Writes one JSON line to the session log.
 *
 * @param {object} entry
 * @param {"debug"|"info"|"warn"|"error"} entry.level
 * @param {string} entry.sessionId
 * @param {string} entry.route
 * @param {string} entry.msg
 * @param {object} [entry.ctx]
 */
export function logEvent({ level, sessionId, route, msg, ctx }) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    sessionId,
    route,
    msg,
    ctx: ctx ?? {},
  });
  stream.write(line + "\n");
}

/** Returns a logger bound to a specific sessionId + route. */
export function sessionLogger(sessionId, route) {
  return {
    sessionId,
    info:  (msg, ctx) => logEvent({ level: "info",  sessionId, route, msg, ctx }),
    warn:  (msg, ctx) => logEvent({ level: "warn",  sessionId, route, msg, ctx }),
    error: (msg, ctx) => logEvent({ level: "error", sessionId, route, msg, ctx }),
    debug: (msg, ctx) => logEvent({ level: "debug", sessionId, route, msg, ctx }),
  };
}

export const LOG_FILE = LOG_PATH;
