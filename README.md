# prod-incident-agent

An automated incident management and remediation system for a 5G device provisioning demo. It combines a LangGraph.js agent, a React frontend, a Fastify provisioning API, and ServiceNow integration to detect, triage, remediate, and verify network coverage errors end-to-end.

```
Browser
  └─▶ app (React + Vite, port 3000)
        └─▶ app/server (Fastify provisioning API, port 3001)
                            ↘ COVERAGE_UNAVAILABLE error
                              └─▶ agent (LangGraph, port 8001)
                                    ├─▶ ServiceNow (create incident)
                                    ├─▶ GitHub (shallow clone source)
                                    ├─▶ app/server GET /api/_logs (fetch runtime logs)
                                    ├─▶ LLM (RCA + fix)
                                    ├─▶ Docker sandbox (verify fix)
                                    └─▶ GitHub (open PR)
```

## Layout

```
.
├── agent/              # LangGraph.js agent + Express API  (port 8001)
│   ├── src/
│   │   ├── index.js        # Express server — POST /run, POST /remediate
│   │   ├── graph.js        # LangGraph state machine
│   │   ├── servicenow.js   # ServiceNow Table API client
│   │   ├── sandbox.js      # Docker sandbox helpers
│   │   ├── workspace.js    # Shallow git clone lifecycle
│   │   └── logs.js         # Fetches runtime logs from app/server HTTP endpoint
│   ├── Dockerfile
│   └── package.json
├── app/                # React / Vite frontend  (port 3000 in dev)
│   ├── src/
│   │   ├── App.jsx          # Main component — calls POST /api/provision
│   │   └── components/      # Header, ProvisionForm, DeviceList, ErrorBanner
│   ├── Dockerfile           # Multi-stage: Vite build → nginx static
│   ├── nginx.conf           # Proxies /api/ → app/server
│   └── vite.config.js
└── app/server/         # Fastify provisioning API  (port 3001)
    ├── src/index.js         # GET /health, POST /api/provision, GET /api/_logs
    ├── Dockerfile
    └── package.json
```

## Quick start

```powershell
# 1. Install
cd agent;       npm install; cd ..
cd app;         npm install; cd ..
cd app\server;  npm install; cd ..\..

# 2. Configure
copy agent\.env.example agent\.env         # fill in ServiceNow creds, LLM key, GitHub token
copy app\server\.env.example app\server\.env  # set LOGS_TOKEN (must match agent value)

# 3. Run (three terminals)
cd agent;      npm start    # → http://localhost:8001
cd app\server; npm start    # → http://localhost:3001
cd app;        npm run dev  # → http://localhost:3000
```

Open `http://localhost:3000` to use the provisioning UI.

## How the agent works

The LangGraph state machine in `agent/src/graph.js` has two paths:

### Ticket path (always runs)

| Node | What it does |
|------|-------------|
| `triage` | Normalises the prompt; calls OpenAI-compatible LLM (or falls back to regex templates) to produce `shortDescription`, `urgency`, `impact`, `category`. |
| `createTicket` | Posts to `POST /api/now/table/incident` on the ServiceNow instance using basic auth. |
| `finalize` | Attaches a convenience deep-link to the new record. |

### Remediation path (runs when `incidentContext` is set)

Triggered by `POST /remediate`. Continues after `finalize` via conditional edge.

| Node | What it does |
|------|-------------|
| `cloneRepo` | Shallow-clones the GitHub repo (`REPO_URL`) into a fresh temp directory. Skipped when `REPO_ROOT` is set (local dev override). |
| `pullLogs` | Fetches runtime log entries from `GET APP_BASE_URL/api/_logs` using the `LOGS_TOKEN` shared secret. |
| `rcaAnalysis` | Reads the cloned source + log evidence, asks the LLM to identify the root cause. |
| `applyFix` | Asks the LLM for the fixed file; writes it to the workspace and captures the git diff. |
| `deploySandbox` | Builds and runs the `app/server` image in Docker (via `sandbox.js`). |
| `verifyScenario` | Sends a `POST /api/provision` to the sandbox and asserts a 200 response. |
| `generateReport` | Builds a structured markdown remediation report. |
| `openPR` | Commits the fix and opens a GitHub pull request from the workspace clone. |
| `cleanupWorkspace` | Removes the temp clone directory. No-op when `REPO_ROOT` was used. |

```
START → triage → createTicket → finalize
                                    │
                    incidentContext? │ yes
                                    ▼
              cloneRepo → pullLogs → rcaAnalysis → applyFix
                → deploySandbox → verifyScenario → generateReport
                → openPR → closeTicket → cleanupWorkspace → END
```

## API reference

### Agent (`POST /run`)
Simple ticket creation — no remediation.

```json
// request
{ "prompt": "5G coverage failure in zip 94105" }

// response
{ "ok": true, "ticket": { "sys_id": "...", "number": "INC001", "link": "..." } }
```

### Agent (`POST /remediate`)
Full auto-remediation pipeline.

```json
// request (all fields optional — shown with defaults)
{
  "segment":   "5G SA",
  "zipCode":   "94105",
  "errorCode": "COVERAGE_UNAVAILABLE",
  "message":   "No coverage available"
}

// response
{
  "ok": true,
  "ticket": { ... },
  "rcaResult": { "rootCause": "...", "affectedFile": "...", ... },
  "fixDiff": "--- a/...",
  "verifyResult": { "passed": true, "status": 200, ... },
  "report": "# Remediation Report ...",
  "prUrl": "https://github.com/.../pull/42"
}
```

### Provisioning API (`POST /api/provision`)
```json
// request
{ "segment": "5G SA", "zipCode": "94105", "deviceId": "DEV-001", "plan": "unlimited" }

// response (success)
{ "ok": true, "deviceId": "DEV-001", "plan": "...", "provisionedAt": "..." }

// response (error)
{ "ok": false, "errorCode": "COVERAGE_UNAVAILABLE", "message": "No coverage available" }
```

### Provisioning API (`GET /api/_logs`)
Internal endpoint used by the agent to fetch runtime log evidence. Requires `X-Logs-Token` header.

```
GET /api/_logs?sessionId=SES-...&limit=200
GET /api/_logs/recent-errors?limit=50
```

## Environment variables

### `agent/.env`

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8001` | Agent HTTP port |
| `SERVICENOW_INSTANCE` | — | e.g. `dev282934` |
| `SERVICENOW_USER` | — | ServiceNow basic-auth username |
| `SERVICENOW_PASSWORD` | — | ServiceNow basic-auth password |
| `OPENAI_API_KEY` | — | Optional — enables LLM triage |
| `OPENAI_BASE_URL` / `LITELLM_BASE_URL` | — | Optional — use a custom / local LLM endpoint |
| `REPO_URL` | — | GitHub repo URL, e.g. `https://github.com/yiftachbz/prod-incident-agent.git` |
| `REPO_BRANCH` | `master` | Branch to clone for each remediation run |
| `GITHUB_TOKEN` | — | PAT with repo read/write + PR creation access |
| `APP_BASE_URL` | — | Base URL of the running app server, e.g. `http://localhost:3001` |
| `LOGS_TOKEN` | — | Shared secret for `GET /api/_logs` (must match `app/server` value) |
| `GIT_DEFAULT_BRANCH` | `master` | Base branch for auto-generated PRs |
| `SANDBOX_PORT` | `3001` | Port the sandbox container listens on |
| `REPO_ROOT` | _(unset)_ | **Local dev only** — skips git clone and reads files from this path instead |

### `app/server/.env`

| Variable | Default | Purpose |
|----------|---------|---------|
| `SERVER_PORT` | `3001` | Provisioning API HTTP port |
| `LOGS_TOKEN` | — | Shared secret for `GET /api/_logs`. Endpoint returns 503 when unset (fail-closed). |
| `LOG_PATH` | `<cwd>/logs/server.jsonl` | Override JSONL log file location |

### Frontend build

| Variable | Purpose |
|----------|---------|
| `VITE_API_URL` | Baked at Vite build time. Empty string = same-origin `/api` (behind nginx). |

### Nginx (runtime in `app/` container)

| Variable | Purpose |
|----------|---------|
| `APP_SERVER_URL` | Upstream for `/api/` proxy, e.g. `http://netprovision-server:3001` |

## Docker

Each service has its own Dockerfile. No compose file is included — run them individually or adapt to your orchestration setup.

| Image | Dockerfile | Exposes |
|-------|-----------|---------|
| Agent | `agent/Dockerfile` | `8001` |
| Frontend (nginx) | `app/Dockerfile` | `80` |
| Provisioning API | `app/server/Dockerfile` | `3001` |

> **Note:** `agent/.env` is git-ignored. Rotate the ServiceNow password before sharing this repo publicly.
