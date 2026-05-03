import "dotenv/config";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import Fastify from "fastify";

const PORT = Number(process.env.SERVER_PORT ?? 3001);

// ---------------------------------------------------------------------------
// Coverage database — zip codes where each 5G segment is available
// ---------------------------------------------------------------------------
const COVERAGE_DB = {
  "5G SA":  ["94105", "94102", "60601", "77001", "30301"],
  "5G NSA": ["94105", "94102", "10019", "60601", "77001", "30301"],
};

// ---------------------------------------------------------------------------
// checkNetworkCoverageByZipCode
// Returns true when the requested segment is available at the given zip code.
// ---------------------------------------------------------------------------
function checkNetworkCoverageByZipCode(zipCode, segment) {
  const coveredZips = COVERAGE_DB[segment] ?? [];
  return coveredZips.includes(String(zipCode).trim());
}

// ---------------------------------------------------------------------------
// Log file path (same default the agent used to read directly)
// ---------------------------------------------------------------------------
function resolveLogFile() {
  if (process.env.LOG_PATH) return path.resolve(process.env.LOG_PATH);
  return path.join(process.cwd(), "logs", "server.jsonl");
}

// ---------------------------------------------------------------------------
// Auth check for internal log endpoints
// ---------------------------------------------------------------------------
function checkLogsToken(req, reply) {
  const secret = process.env.LOGS_TOKEN;
  if (!secret) {
    reply.code(503).send({ ok: false, error: "LOGS_TOKEN not configured on server" });
    return false;
  }
  if (req.headers["x-logs-token"] !== secret) {
    reply.code(401).send({ ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
const app = Fastify({ logger: true });

app.get("/health", async () => ({ ok: true, service: "netprovision-server" }));

// ---------------------------------------------------------------------------
// POST /api/provision
// ---------------------------------------------------------------------------
app.post("/api/provision", {
  schema: {
    body: {
      type: "object",
      required: ["name", "segment", "zipCode"],
      properties: {
        name:    { type: "string", minLength: 1 },
        segment: { type: "string", minLength: 1 },
        zipCode: { type: "string", minLength: 1 },
      },
    },
  },
}, async (req, reply) => {
  const { name, segment, zipCode } = req.body;

  const hasCoverage = checkNetworkCoverageByZipCode(zipCode, segment);

  if (!hasCoverage) {
    return reply.code(400).send({
      ok: false,
      code: "COVERAGE_UNAVAILABLE",
      message: `No ${segment} coverage available in your domestic service area.`,
      detail:
        `The requested network segment "${segment}" could not be provisioned for zip code ${zipCode}. ` +
        "No coverage is available in this area.",
      requestId: `REQ-${Date.now()}`,
      segment,
      zipCode,
    });
  }

  return reply.send({
    ok: true,
    message: "Network provisioned successfully",
    accountName: name,
    segment,
    zipCode,
    requestId: `REQ-${Date.now()}`,
  });
});

// ---------------------------------------------------------------------------
// GET /api/_logs?sessionId=...&limit=200
// ---------------------------------------------------------------------------
app.get("/api/_logs", async (req, reply) => {
  if (!checkLogsToken(req, reply)) return;

  const sessionId = req.query.sessionId ?? null;
  const limit = Math.min(Number(req.query.limit ?? 200), 1000);
  const logFile = resolveLogFile();

  try {
    await stat(logFile);
  } catch {
    return reply.send({ found: false, entries: [] });
  }

  const entries = [];
  const rl = createInterface({
    input: createReadStream(logFile, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    if (sessionId && !line.includes(sessionId)) continue;
    try {
      const obj = JSON.parse(line);
      if (!sessionId || obj.sessionId === sessionId) {
        entries.push(obj);
        if (entries.length >= limit) break;
      }
    } catch {
      // skip malformed lines
    }
  }

  return reply.send({ found: entries.length > 0, entries });
});

// ---------------------------------------------------------------------------
// GET /api/_logs/recent-errors?limit=50
// ---------------------------------------------------------------------------
app.get("/api/_logs/recent-errors", async (req, reply) => {
  if (!checkLogsToken(req, reply)) return;

  const limit = Math.min(Number(req.query.limit ?? 50), 500);
  const logFile = resolveLogFile();

  try {
    await stat(logFile);
  } catch {
    return reply.send({ found: false, entries: [] });
  }

  const buffer = [];
  const rl = createInterface({
    input: createReadStream(logFile, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.level === "error" || obj.level === "warn") {
        buffer.push(obj);
        if (buffer.length > limit) buffer.shift();
      }
    } catch {
      // skip malformed lines
    }
  }

  return reply.send({ found: buffer.length > 0, entries: buffer });
});

// ---------------------------------------------------------------------------

await app.listen({ port: PORT, host: "0.0.0.0" });
