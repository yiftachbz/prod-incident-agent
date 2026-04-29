# prod-incident-agent

An automated incident management and remediation system for a 5G device provisioning demo. It combines a LangGraph.js agent, a React frontend, a Fastify provisioning API, and ServiceNow integration to detect, triage, remediate, and verify network coverage errors end-to-end.

```
Browser
  └─▶ app (React + Vite, port 3000)
        └─▶ app/server (Fastify provisioning API, port 3001)
                            ↘ COVERAGE_UNAVAILABLE error
                              └─▶ agent (LangGraph, port 8001)
                                    ├─▶ ServiceNow (create incident)
                                    ├─▶ Claude CLI (RCA + fix)
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
│   │   └── sandbox.js      # Docker sandbox helpers
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
    ├── src/index.js         # GET /health, POST /api/provision
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
copy agent\.env.example agent\.env   # fill in ServiceNow creds + LLM key

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
| `rcaAnalysis` | Shells out to **`claude --print`** with file-system tools to identify root cause (`affectedFile`, `fixType`, etc.). |
| `applyFix` | Calls `claude` again to apply the actual code change; captures the unified diff. |
| `deploySandbox` | Builds and runs the `app/server` image in Docker (via `sandbox.js`); falls back gracefully when Docker is unavailable. |
| `verifyScenario` | Sends a `POST /api/provision` to the sandbox and checks the response matches expectations. |
| `generateReport` | Asks `claude` to write a full markdown remediation report. |
| `openPR` | Runs `git` + `gh` to commit the fix and open a GitHub pull request when verification passes. |

```
START → triage → createTicket → finalize
                                    │
                    incidentContext? │ yes
                                    ▼
              rcaAnalysis → applyFix → deploySandbox
                → verifyScenario → generateReport → openPR → END
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
| `REPO_ROOT` | `cwd` | Absolute path to repo root (Docker: `/repo`) |
| `GIT_DEFAULT_BRANCH` | `master` | Base branch for PRs |
| `SANDBOX_PORT` | `3001` | Port the sandbox container is published on |

### `app/server/.env`

| Variable | Default | Purpose |
|----------|---------|---------|
| `SERVER_PORT` | `3001` | Provisioning API HTTP port |

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

The `agent/Dockerfile` copies the **full repo** to `/repo` (for RCA file access) and installs `git`, `curl`, Docker CLI, and `gh` at build time.

> **Note:** `agent/.env` is git-ignored. Rotate the ServiceNow password before sharing this repo publicly.
