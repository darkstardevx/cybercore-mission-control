#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const port = 8787;

function command(args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(npx, ["wrangler", ...args], {
      cwd: ROOT,
      env: { ...process.env, WRANGLER_LOG_PATH: "none" },
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 60_000);
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 45_000;
  let lastError = "server did not start";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`local Worker exited before health check: ${lastError}`);
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = `health returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`local Worker health timeout: ${lastError}`);
}

async function request(base, path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await response.json();
  return { response, body };
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise();
    }, 5_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

const state = await mkdtemp(resolve(tmpdir(), "cybercore-mission-control-smoke-"));
let worker;
try {
  const migration = await command(["d1", "migrations", "apply", "MISSION_CONTROL_DB", "--local", "--persist-to", state]);
  assert.equal(migration.code, 0, migration.stderr || migration.stdout);

  worker = spawn(npx, ["wrangler", "dev", "--local", "--persist-to", state, "--port", String(port), "--log-level", "error"], {
    cwd: ROOT,
    env: { ...process.env, WRANGLER_LOG_PATH: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let workerOutput = "";
  worker.stdout.on("data", (chunk) => { workerOutput += chunk; });
  worker.stderr.on("data", (chunk) => { workerOutput += chunk; });

  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(base, worker);
  const health = await request(base, "/api/health");
  assert.equal(health.response.status, 200);
  assert.equal(health.body.environment, "local");

  const unauthorized = await request(base, "/api/projects");
  assert.equal(unauthorized.response.status, 401);

  const project = await request(base, "/api/projects", {
    method: "POST",
    headers: { "x-mission-control-admin": "demo-admin" },
    body: JSON.stringify({ name: "Smoke Project", mission: "Disposable local verification" }),
  });
  assert.equal(project.response.status, 201);
  const projectId = project.body.project.id;

  const registration = await request(base, "/api/agents/register", {
    method: "POST",
    headers: { "x-mission-control-admin": "demo-admin" },
    body: JSON.stringify({
      project_id: projectId,
      machine_name: "smoke-machine",
      platform: "linux",
      connector_version: "smoke",
      agent_name: "smoke-agent",
      agent_version: "smoke",
    }),
  });
  assert.equal(registration.response.status, 201);
  const agentId = registration.body.agent.id;
  const credential = registration.body.credential;
  assert.match(credential, /^mc_[a-z0-9]+$/);

  const heartbeat = {
    nonce: `smoke-${Date.now()}`,
    observed_at: new Date().toISOString(),
    status: "online",
    payload: { source: "local-smoke" },
  };
  const accepted = await request(base, `/api/agents/${agentId}/heartbeat`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
    body: JSON.stringify(heartbeat),
  });
  assert.equal(accepted.response.status, 202);

  const replayed = await request(base, `/api/agents/${agentId}/heartbeat`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
    body: JSON.stringify(heartbeat),
  });
  assert.equal(replayed.response.status, 409);
  assert.equal(replayed.body.code, "replayed_heartbeat");

  const audit = await request(base, `/api/projects/${projectId}/audit`, {
    headers: { "x-mission-control-admin": "demo-admin" },
  });
  assert.equal(audit.response.status, 200);
  assert.ok(audit.body.events.length >= 3);
  console.log("local smoke passed: health, auth, migration, registration, heartbeat, replay rejection, audit");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`${message}\nworker output:\n${worker?.output ?? "(unavailable)"}`);
} finally {
  if (worker) await stop(worker);
  await rm(state, { recursive: true, force: true });
}
