/**
 * Workspace manager — shallow git clone lifecycle.
 *
 * Clones the GitHub repo into a unique temp directory for each remediation
 * run, so the agent never needs filesystem access to the real repo checkout.
 *
 * Required env vars (when REPO_ROOT is NOT set):
 *   REPO_URL      — e.g. https://github.com/yiftachbz/prod-incident-agent.git
 *   REPO_BRANCH   — default "master"
 *   GITHUB_TOKEN  — used to authenticate the clone and subsequent git push
 *
 * Optional dev override:
 *   REPO_ROOT     — if set, skips the clone entirely and returns this path
 *                   as the workspacePath. Cleanup is a no-op in this case.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Shallow-clone the repo into a fresh temp directory.
 *
 * @param {object} opts
 * @param {string} opts.repoUrl    Full HTTPS URL to the repository.
 * @param {string} opts.branch     Branch to clone (default "master").
 * @param {string} opts.token      GitHub personal access token.
 * @returns {Promise<{ workspacePath: string, cleanup: () => Promise<void> }>}
 */
export async function cloneRepoToTemp({ repoUrl, branch = "master", token }) {
  // Inject the token into the HTTPS URL without logging it.
  const authUrl = repoUrl.replace("https://", `https://x-access-token:${token}@`);

  // Create an isolated temp directory.
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "prod-incident-agent-"));

  console.log(`[workspace] cloning ${repoUrl} (branch=${branch}) into ${workspacePath}`);
  await execFileAsync(
    "git",
    ["clone", "--depth", "1", "--branch", branch, authUrl, workspacePath],
    { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }
  );

  // Configure git identity inside the workspace so commits work.
  await execFileAsync("git", ["config", "user.email", "agent@prod-incident-agent"], { cwd: workspacePath });
  await execFileAsync("git", ["config", "user.name", "prod-incident-agent"], { cwd: workspacePath });

  // Update the remote origin to include the auth token so `git push` succeeds.
  await execFileAsync("git", ["remote", "set-url", "origin", authUrl], { cwd: workspacePath });

  console.log(`[workspace] clone ready at ${workspacePath}`);

  const cleanup = async () => {
    try {
      await rm(workspacePath, { recursive: true, force: true });
      console.log(`[workspace] cleaned up ${workspacePath}`);
    } catch (err) {
      console.warn(`[workspace] cleanup failed (ignored): ${err.message}`);
    }
  };

  return { workspacePath, cleanup };
}

/**
 * Resolve the workspace path from state or fall back to the REPO_ROOT
 * dev override.
 *
 * @param {object} state  LangGraph agent state.
 * @returns {string}
 */
export function resolveWorkspacePath(state) {
  return process.env.REPO_ROOT ?? state.workspacePath;
}
