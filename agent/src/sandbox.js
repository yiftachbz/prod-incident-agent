/**
 * Docker-based sandbox manager.
 *
 * Builds a fresh image from the patched app/server source and starts an
 * ephemeral container for HTTP verification. Agent and production app server
 * do NOT need to be on the same machine — the sandbox is built and run
 * entirely within the agent's Docker environment.
 *
 * Networking strategy (avoids the port-publishing / localhost trap):
 *   A dedicated bridge network is created for each sandbox run. The agent's
 *   own container is connected to it, and the sandbox container is started on
 *   it. They communicate over Docker DNS using the container name — no
 *   published ports and no SANDBOX_HOST env var are needed.
 *
 * Requirements:
 *   - Docker daemon accessible from the agent container:
 *       docker run -v /var/run/docker.sock:/var/run/docker.sock ...
 *   - Works on ECS EC2 (bridge / host networkMode).
 *   - On ECS Fargate (no socket) the caller catches the error and falls back
 *     to inline code analysis.
 *
 * Environment variables:
 *   SANDBOX_PORT  Port the app server listens on inside the container (default 3001).
 *                 Only change this if the app server Dockerfile exposes a different port.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { access } from "fs/promises";
import path from "path";

const execFileAsync = promisify(execFile);

let _containerId   = null;
let _containerName = null;
let _networkName   = null;
let _agentConnected = false;  // true when we added the agent container to the network

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns true when the process is running inside a Docker container. */
async function isInsideDocker() {
  try {
    await access("/.dockerenv");
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the Docker-resolvable identifier for the agent's own container.
 * Docker sets HOSTNAME to the short container ID (12 hex chars) by default.
 */
function agentContainerId() {
  return process.env.HOSTNAME ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a Docker image from {repoRoot}/app/server, create a dedicated bridge
 * network, connect the agent's own container to it, then start the sandbox
 * container on that network. Waits up to 30 s for /health to respond.
 *
 * @param {string} repoRoot  Absolute path to the repository root (REPO_ROOT).
 * @returns {Promise<{ containerId: string, host: string, port: number }>}
 *   host  — Docker DNS name (container name) reachable on the shared network.
 *   port  — internal port the server listens on (SANDBOX_PORT, default 3001).
 */
export async function startSandbox(repoRoot) {
  await stopSandbox();

  const ts          = Date.now();
  const serverDir   = path.join(repoRoot, "app", "server");
  const tag         = `netprovision-sandbox:${ts}`;
  const name        = `netprovision-sandbox-${ts}`;
  const network     = `sandbox-net-${ts}`;
  const innerPort   = Number(process.env.SANDBOX_PORT ?? 3001);

  // ── 1. Build image from the patched source ────────────────────────────────
  console.log(`[sandbox] building image ${tag} from ${serverDir}`);
  await execFileAsync("docker", ["build", "-t", tag, serverDir], {
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  // ── 2. Create a dedicated bridge network ──────────────────────────────────
  console.log(`[sandbox] creating network ${network}`);
  await execFileAsync("docker", ["network", "create", network]);
  _networkName = network;

  // ── 3. Connect the agent's own container to the network ───────────────────
  //      (only when running inside Docker; on bare metal skip this step)
  if (await isInsideDocker()) {
    const self = agentContainerId();
    if (self) {
      console.log(`[sandbox] connecting agent container ${self} to ${network}`);
      await execFileAsync("docker", ["network", "connect", network, self]);
      _agentConnected = true;
    }
  }

  // ── 4. Start the sandbox container ────────────────────────────────────────
  //
  //  Strategy differs by environment:
  //
  //  Inside Docker (ECS EC2, CI container, etc.)
  //    → No port publishing. Container joined to the bridge network above.
  //      Agent reaches sandbox by container name via Docker DNS.
  //
  //  Local dev (bare metal / Docker Desktop on macOS or Windows)
  //    → Docker bridge networks are NOT reachable from the host on macOS/Windows.
  //      Use port publishing (-p innerPort:innerPort) and reach via localhost.
  //      The bridge network is still created (for consistency) but not used
  //      for routing in this case.
  //
  const runArgs = [
    "run", "-d",
    "--name", name,
    "--network", network,
    "-e", `SERVER_PORT=${innerPort}`,
  ];

  const inDocker = await isInsideDocker();
  if (!inDocker) {
    runArgs.splice(4, 0, "-p", `${innerPort}:${innerPort}`);
  }

  runArgs.push(tag);

  console.log(`[sandbox] starting container ${name}`);
  const { stdout } = await execFileAsync("docker", runArgs);
  _containerId   = stdout.trim();
  _containerName = name;
  console.log(`[sandbox] container id: ${_containerId.slice(0, 12)}`);

  // ── 5. Poll /health until the server is ready ─────────────────────────────
  //  Inside Docker  → container name resolves via Docker DNS on the bridge net.
  //  Local dev      → port is published, use localhost.
  const host      = inDocker ? name : "localhost";
  const port      = innerPort;
  const healthUrl = `http://${host}:${port}/health`;
  const deadline  = Date.now() + 30_000;

  console.log(`[sandbox] waiting for health at ${healthUrl}`);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) {
        console.log(`[sandbox] healthy at ${healthUrl}`);
        return { containerId: _containerId, host, port };
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  await stopSandbox();
  throw new Error(`Sandbox did not become healthy at ${healthUrl} within 30 s`);
}

/**
 * Stop the sandbox container and tear down the dedicated network.
 */
export async function stopSandbox() {
  // Remove sandbox container
  if (_containerId) {
    const id = _containerId;
    _containerId   = null;
    _containerName = null;
    try {
      await execFileAsync("docker", ["rm", "-f", id]);
      console.log(`[sandbox] container ${id.slice(0, 12)} removed`);
    } catch (err) {
      console.warn("[sandbox] container removal failed:", err.message);
    }
  }

  // Disconnect agent's own container from the sandbox network
  if (_agentConnected && _networkName) {
    const self = agentContainerId();
    if (self) {
      try {
        await execFileAsync("docker", ["network", "disconnect", _networkName, self]);
      } catch {
        // best-effort
      }
    }
    _agentConnected = false;
  }

  // Remove the bridge network
  if (_networkName) {
    const net = _networkName;
    _networkName = null;
    try {
      await execFileAsync("docker", ["network", "rm", net]);
      console.log(`[sandbox] network ${net} removed`);
    } catch (err) {
      console.warn("[sandbox] network removal failed:", err.message);
    }
  }
}
