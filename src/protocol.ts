export const MAX_BODY_BYTES = 32 * 1024;
export const MAX_NAME_LENGTH = 120;
export const MAX_MISSION_LENGTH = 500;
export const MAX_PAYLOAD_BYTES = 16 * 1024;
export const HEARTBEAT_MAX_AGE_MS = 5 * 60 * 1000;
export const HEARTBEAT_FUTURE_SKEW_MS = 30 * 1000;

export type Scope = "heartbeat:write" | "reports:write";

export type ProjectInput = {
  name: string;
  mission?: string;
};

export type AgentRegistrationInput = {
  project_id: string;
  machine_name: string;
  platform?: string;
  connector_version?: string;
  agent_name: string;
  agent_version?: string;
  scopes?: Scope[];
};

export type HeartbeatInput = {
  nonce: string;
  observed_at: string;
  status?: "online" | "offline" | "degraded";
  payload?: Record<string, unknown>;
};

export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "invalid_request",
  ) {
    super(message);
  }
}

export function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requiredString(
  value: unknown,
  label: string,
  maxLength = MAX_NAME_LENGTH,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProtocolError(`${label} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ProtocolError(`${label} exceeds ${maxLength} characters`);
  }
  return normalized;
}

export function optionalString(
  value: unknown,
  label: string,
  maxLength: number,
  fallback: string,
): string {
  if (value === undefined || value === null || value === "") return fallback;
  return requiredString(value, label, maxLength);
}

export function parseProjectInput(value: unknown): ProjectInput {
  const input = assertObject(value, "project");
  return {
    name: requiredString(input.name, "name"),
    mission: optionalString(input.mission, "mission", MAX_MISSION_LENGTH, ""),
  };
}

export function parseAgentRegistration(value: unknown): AgentRegistrationInput {
  const input = assertObject(value, "agent");
  const rawScopes = input.scopes === undefined ? ["heartbeat:write"] : input.scopes;
  if (!Array.isArray(rawScopes) || rawScopes.some((scope) => scope !== "heartbeat:write" && scope !== "reports:write")) {
    throw new ProtocolError("scopes must contain only supported values");
  }
  return {
    project_id: requiredString(input.project_id, "project_id", 80),
    machine_name: requiredString(input.machine_name, "machine_name"),
    platform: optionalString(input.platform, "platform", 80, "unknown"),
    connector_version: optionalString(input.connector_version, "connector_version", 80, "unknown"),
    agent_name: requiredString(input.agent_name, "agent_name"),
    agent_version: optionalString(input.agent_version, "agent_version", 80, "unknown"),
    scopes: [...new Set(rawScopes)] as Scope[],
  };
}

export function parseHeartbeat(value: unknown): HeartbeatInput {
  const input = assertObject(value, "heartbeat");
  const observedAt = requiredString(input.observed_at, "observed_at", 40);
  const timestamp = Date.parse(observedAt);
  if (!Number.isFinite(timestamp)) throw new ProtocolError("observed_at must be an ISO timestamp");
  const now = Date.now();
  if (timestamp < now - HEARTBEAT_MAX_AGE_MS) throw new ProtocolError("heartbeat is too old", 400, "stale_heartbeat");
  if (timestamp > now + HEARTBEAT_FUTURE_SKEW_MS) throw new ProtocolError("heartbeat is from the future", 400, "future_heartbeat");
  const payload = input.payload === undefined ? {} : assertObject(input.payload, "payload");
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  if (payloadBytes > MAX_PAYLOAD_BYTES) throw new ProtocolError("heartbeat payload is too large", 413, "payload_too_large");
  return {
    nonce: requiredString(input.nonce, "nonce", 160),
    observed_at: new Date(timestamp).toISOString(),
    status: input.status === undefined ? "online" : input.status as HeartbeatInput["status"],
    payload: payload as Record<string, unknown>,
  };
}

export async function readJson(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length && Number(length) > MAX_BODY_BYTES) {
    throw new ProtocolError("request body is too large", 413, "body_too_large");
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) {
    throw new ProtocolError("request body is too large", 413, "body_too_large");
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ProtocolError("request body must be valid JSON");
  }
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function json(data: unknown, status = 200, requestId?: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(requestId ? { "x-request-id": requestId } : {}),
    },
  });
}
