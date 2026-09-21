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

async function openEvents(base, projectId) {
  const socket = new WebSocket(`${base}/api/projects/${projectId}/events`, ["mc-admin.demo-admin"]);
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("event WebSocket open timeout")), 5_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolvePromise(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("event WebSocket failed to open")); }, { once: true });
  });
  const event = new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("event WebSocket message timeout")), 5_000);
    socket.addEventListener("message", (message) => { clearTimeout(timer); resolvePromise(JSON.parse(message.data)); }, { once: true });
  });
  return { socket, event };
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
  assert.equal(unauthorized.body.code, "admin_required");

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
  const events = await openEvents(base, projectId);

  const missingCredential = await request(base, `/api/agents/${agentId}/heartbeat`, {
    method: "POST",
    body: JSON.stringify({ nonce: "missing-credential", observed_at: new Date().toISOString() }),
  });
  assert.equal(missingCredential.response.status, 401);
  assert.equal(missingCredential.body.code, "agent_required");

  const malformed = await request(base, `/api/agents/${agentId}/heartbeat`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
    body: "not-json",
  });
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.body.code, "invalid_request");

  const stale = await request(base, `/api/agents/${agentId}/heartbeat`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
    body: JSON.stringify({ nonce: "stale", observed_at: new Date(Date.now() - 6 * 60 * 1000).toISOString() }),
  });
  assert.equal(stale.response.status, 400);
  assert.equal(stale.body.code, "stale_heartbeat");

  const future = await request(base, `/api/agents/${agentId}/heartbeat`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
    body: JSON.stringify({ nonce: "future", observed_at: new Date(Date.now() + 60 * 1000).toISOString() }),
  });
  assert.equal(future.response.status, 400);
  assert.equal(future.body.code, "future_heartbeat");

  const oversized = await request(base, `/api/agents/${agentId}/heartbeat`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
    body: JSON.stringify({ nonce: "oversized", observed_at: new Date().toISOString(), payload: { data: "x".repeat(17 * 1024) } }),
  });
  assert.equal(oversized.response.status, 413);
  assert.equal(oversized.body.code, "payload_too_large");

  const invalidStatus = await request(base, `/api/agents/${agentId}/heartbeat`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
    body: JSON.stringify({ nonce: "invalid-status", observed_at: new Date().toISOString(), status: "unknown" }),
  });
  assert.equal(invalidStatus.response.status, 400);
  assert.equal(invalidStatus.body.code, "invalid_request");

  const mismatch = await request(base, "/api/agents/not-this-agent/heartbeat", {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
    body: JSON.stringify({ nonce: "mismatch", observed_at: new Date().toISOString() }),
  });
  assert.equal(mismatch.response.status, 403);
  assert.equal(mismatch.body.code, "agent_mismatch");

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
  const liveEvent = await events.event;
  assert.equal(liveEvent.type, "agent.heartbeat");
  events.socket.close();

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
  console.log("local smoke passed: health, migration, auth failures, registration, heartbeat bounds, live event, replay rejection, audit");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`${message}\nworker output:\n${worker?.output ?? "(unavailable)"}`);
} finally {
  if (worker) await stop(worker);
  await rm(state, { recursive: true, force: true });
}
