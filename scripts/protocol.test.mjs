import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_BODY_BYTES,
  MAX_PAYLOAD_BYTES,
  parseAgentRegistration,
  parseHeartbeat,
  parseProjectInput,
  readJson,
} from "../src/protocol.ts";

test("project and registration inputs enforce bounded fields", () => {
  assert.equal(parseProjectInput({ name: " Demo " }).name, "Demo");
  assert.throws(() => parseProjectInput({ name: "x".repeat(121) }), /exceeds 120/);
  assert.throws(() => parseAgentRegistration({
    project_id: "prj_demo",
    machine_name: "machine",
    agent_name: "agent",
    scopes: ["admin:write"],
  }), /supported values/);
});

test("heartbeat parser rejects invalid status, stale, future, and oversized payloads", () => {
  const now = new Date().toISOString();
  assert.equal(parseHeartbeat({ nonce: "n", observed_at: now }).status, "online");
  assert.throws(() => parseHeartbeat({ nonce: "n", observed_at: now, status: "unknown" }), /status must be/);
  assert.throws(() => parseHeartbeat({ nonce: "n", observed_at: new Date(Date.now() - 6 * 60 * 1000).toISOString() }), /too old/);
  assert.throws(() => parseHeartbeat({ nonce: "n", observed_at: new Date(Date.now() + 60 * 1000).toISOString() }), /from the future/);
  assert.throws(() => parseHeartbeat({ nonce: "n", observed_at: now, payload: { data: "x".repeat(MAX_PAYLOAD_BYTES) } }), /too large/);
});

test("request JSON parser rejects malformed and oversized bodies", async () => {
  await assert.rejects(() => readJson(new Request("https://example.test", { method: "POST", body: "not-json" })), /valid JSON/);
  const oversized = new Request("https://example.test", {
    method: "POST",
    headers: { "content-length": String(MAX_BODY_BYTES + 1) },
    body: "{}",
  });
  await assert.rejects(() => readJson(oversized), /too large/);
});
