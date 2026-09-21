import type { AgentRegistrationInput, HeartbeatInput, ProjectInput } from "./protocol";

export type Env = {
  MISSION_CONTROL_DB: D1Database;
  PROJECT_EVENTS: DurableObjectNamespace;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  ADMIN_TOKEN?: string;
};

type ProjectRow = {
  id: string;
  name: string;
  mission: string;
  created_at: string;
};

type MachineRow = {
  id: string;
  project_id: string;
  name: string;
  platform: string;
  connector_version: string;
  created_at: string;
  last_seen_at: string | null;
  status: "online" | "offline" | "unknown";
};

type AgentRow = {
  id: string;
  machine_id: string;
  name: string;
  version: string;
  scopes_json: string;
  created_at: string;
  revoked_at: string | null;
  project_id: string;
};

export type AuthenticatedAgent = AgentRow & {
  project_id: string;
  machine_name: string;
};

export type AuditEvent = {
  id: string;
  project_id: string;
  actor: string;
  event_type: string;
  resource_type: string;
  resource_id: string | null;
  request_id: string;
  occurred_at: string;
  payload_json: string;
};

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function now(): string {
  return new Date().toISOString();
}

export async function projectExists(db: D1Database, projectId: string): Promise<boolean> {
  const row = await db.prepare("SELECT id FROM projects WHERE id = ?1").bind(projectId).first<{ id: string }>();
  return Boolean(row);
}

export async function createProject(db: D1Database, input: ProjectInput): Promise<ProjectRow> {
  const project: ProjectRow = { id: id("prj"), name: input.name, mission: input.mission ?? "", created_at: now() };
  await db.prepare("INSERT INTO projects (id, name, mission, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(project.id, project.name, project.mission, project.created_at).run();
  return project;
}

export async function listProjects(db: D1Database): Promise<ProjectRow[]> {
  const result = await db.prepare("SELECT id, name, mission, created_at FROM projects ORDER BY created_at DESC").all<ProjectRow>();
  return result.results;
}

export async function getProject(db: D1Database, projectId: string): Promise<ProjectRow | null> {
  return db.prepare("SELECT id, name, mission, created_at FROM projects WHERE id = ?1").bind(projectId).first<ProjectRow>();
}

export async function createAgent(
  db: D1Database,
  input: AgentRegistrationInput,
  credentialHash: string,
): Promise<{ agent: AgentRow; machine: MachineRow; projectId: string }> {
  const timestamp = now();
  const machine: MachineRow = {
    id: id("mch"), project_id: input.project_id, name: input.machine_name,
    platform: input.platform ?? "unknown", connector_version: input.connector_version ?? "unknown",
    created_at: timestamp, last_seen_at: null, status: "unknown",
  };
  await db.prepare(
    "INSERT INTO machines (id, project_id, name, platform, connector_version, created_at, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  ).bind(machine.id, machine.project_id, machine.name, machine.platform, machine.connector_version, machine.created_at, machine.status).run();

  const agent: AgentRow = {
    id: id("agt"), machine_id: machine.id, name: input.agent_name,
    version: input.agent_version ?? "unknown", scopes_json: JSON.stringify(input.scopes ?? ["heartbeat:write"]),
    created_at: timestamp, revoked_at: null, project_id: input.project_id,
  };
  await db.prepare(
    "INSERT INTO agents (id, machine_id, name, version, scopes_json, credential_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  ).bind(agent.id, agent.machine_id, agent.name, agent.version, agent.scopes_json, credentialHash, agent.created_at).run();
  return { agent, machine, projectId: input.project_id };
}

export async function authenticateAgent(db: D1Database, credentialHash: string): Promise<AuthenticatedAgent | null> {
  return db.prepare(
    "SELECT a.id, a.machine_id, a.name, a.version, a.scopes_json, a.created_at, a.revoked_at, m.project_id, m.name AS machine_name FROM agents a JOIN machines m ON m.id = a.machine_id WHERE a.credential_hash = ?1 AND a.revoked_at IS NULL",
  ).bind(credentialHash).first<AuthenticatedAgent>();
}

export async function listAgents(db: D1Database, projectId: string): Promise<Array<Record<string, unknown>>> {
  const result = await db.prepare(
    "SELECT a.id, a.name, a.version, a.scopes_json, a.created_at, m.id AS machine_id, m.name AS machine_name, m.platform, m.last_seen_at, m.status FROM agents a JOIN machines m ON m.id = a.machine_id WHERE m.project_id = ?1 ORDER BY m.name, a.name",
  ).bind(projectId).all<Record<string, unknown>>();
  return result.results.map((row) => ({ ...row, scopes: JSON.parse(String(row.scopes_json)) }));
}

export async function recordHeartbeat(
  db: D1Database,
  agent: AuthenticatedAgent,
  heartbeat: HeartbeatInput,
): Promise<{ heartbeatId: string; machineId: string }> {
  const heartbeatId = id("hb");
  await db.prepare(
    "INSERT INTO heartbeats (id, agent_id, observed_at, nonce, status, payload_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).bind(heartbeatId, agent.id, heartbeat.observed_at, heartbeat.nonce, heartbeat.status ?? "online", JSON.stringify(heartbeat.payload ?? {})).run();
  await db.prepare(
    "UPDATE machines SET last_seen_at = ?1, status = ?2, platform = platform, connector_version = connector_version WHERE id = ?3",
  ).bind(heartbeat.observed_at, heartbeat.status ?? "online", agent.machine_id).run();
  return { heartbeatId, machineId: agent.machine_id };
}

export async function listAudit(db: D1Database, projectId: string, limit = 50): Promise<AuditEvent[]> {
  const bounded = Math.max(1, Math.min(limit, 100));
  const result = await db.prepare(
    "SELECT id, project_id, actor, event_type, resource_type, resource_id, request_id, occurred_at, payload_json FROM audit_events WHERE project_id = ?1 ORDER BY occurred_at DESC LIMIT ?2",
  ).bind(projectId, bounded).all<AuditEvent>();
  return result.results;
}

export async function audit(
  db: D1Database,
  input: Omit<AuditEvent, "id" | "occurred_at"> & { occurred_at?: string },
): Promise<AuditEvent> {
  const event: AuditEvent = { ...input, id: id("evt"), occurred_at: input.occurred_at ?? now() };
  await db.prepare(
    "INSERT INTO audit_events (id, project_id, actor, event_type, resource_type, resource_id, request_id, occurred_at, payload_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
  ).bind(event.id, event.project_id, event.actor, event.event_type, event.resource_type, event.resource_id, event.request_id, event.occurred_at, event.payload_json).run();
  return event;
}
