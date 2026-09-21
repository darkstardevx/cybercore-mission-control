import { DurableObject } from "cloudflare:workers";
import {
  AgentRegistrationInput,
  ProtocolError,
  assertObject,
  json,
  parseAgentRegistration,
  parseHeartbeat,
  parseProjectInput,
  readJson,
  sha256,
} from "./protocol";
import {
  Env,
  audit,
  authenticateAgent,
  createAgent,
  createProject,
  getProject,
  listAgents,
  listAudit,
  listProjects,
  projectExists,
  recordHeartbeat,
} from "./db";

const REQUEST_ID = "x-request-id";

export class ProjectEventChannel extends DurableObject<Env> {
  private readonly sockets = new Set<WebSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const socket of ctx.getWebSockets()) this.sockets.add(socket);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this.sockets.add(server);
      const protocol = request.headers.get("sec-websocket-protocol")?.split(",").map((value) => value.trim()).find((value) => value.startsWith("mc-admin."));
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: protocol ? { "sec-websocket-protocol": protocol } : undefined,
      });
    }
    if (request.method === "POST") {
      const event = await request.json();
      const message = JSON.stringify(event);
      for (const socket of this.sockets) {
        try { socket.send(message); } catch { this.sockets.delete(socket); }
      }
      return new Response(null, { status: 204 });
    }
    return new Response("Not found", { status: 404 });
  }

  webSocketClose(socket: WebSocket): void {
    this.sockets.delete(socket);
  }

  webSocketError(socket: WebSocket): void {
    this.sockets.delete(socket);
  }

  webSocketMessage(): void {
    // Client-to-server messages are intentionally ignored in this observation-only channel.
  }
}

function requestId(request: Request): string {
  return request.headers.get(REQUEST_ID)?.trim() || crypto.randomUUID();
}

function adminAuthorized(request: Request, env: Env): boolean {
  const provided = request.headers.get("x-mission-control-admin");
  const websocketProtocol = request.headers.get("sec-websocket-protocol")?.split(",").map((value) => value.trim()).find((value) => value.startsWith("mc-admin."));
  const expected = env.ADMIN_TOKEN || (env.ENVIRONMENT === "local" ? "demo-admin" : "");
  return Boolean(expected && (provided === expected || websocketProtocol === `mc-admin.${expected}`));
}

function adminFailure(id: string): Response {
  return json({ error: "admin authorization required", code: "admin_required", request_id: id }, 401, id);
}

function routeParts(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

async function publish(env: Env, projectId: string, event: unknown): Promise<void> {
  const objectId = env.PROJECT_EVENTS.idFromName(projectId);
  await env.PROJECT_EVENTS.get(objectId).fetch("https://events.internal/publish", {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-event": "mission-control" },
    body: JSON.stringify(event),
  });
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const id = requestId(request);
  const url = new URL(request.url);
  const parts = routeParts(url.pathname);

  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({ ok: true, service: "cybercore-mission-control", environment: env.ENVIRONMENT, observed_at: new Date().toISOString() }, 200, id);
  }

  if (request.method === "POST" && url.pathname === "/api/projects") {
    if (!adminAuthorized(request, env)) return adminFailure(id);
    const project = await createProject(env.MISSION_CONTROL_DB, parseProjectInput(await readJson(request)));
    await audit(env.MISSION_CONTROL_DB, {
      project_id: project.id, actor: "operator", event_type: "project.created",
      resource_type: "project", resource_id: project.id, request_id: id,
      payload_json: JSON.stringify({ name: project.name }),
    });
    return json({ project }, 201, id);
  }

  if (request.method === "GET" && url.pathname === "/api/projects") {
    if (!adminAuthorized(request, env)) return adminFailure(id);
    return json({ projects: await listProjects(env.MISSION_CONTROL_DB) }, 200, id);
  }

  if (parts[0] === "api" && parts[1] === "projects" && parts[2]) {
    const projectId = parts[2];
    if (request.method === "GET" && parts[3] === "agents") {
      if (!adminAuthorized(request, env)) return adminFailure(id);
      if (!await projectExists(env.MISSION_CONTROL_DB, projectId)) return json({ error: "project not found" }, 404, id);
      return json({ agents: await listAgents(env.MISSION_CONTROL_DB, projectId) }, 200, id);
    }
    if (request.method === "GET" && parts[3] === "audit") {
      if (!adminAuthorized(request, env)) return adminFailure(id);
      if (!await projectExists(env.MISSION_CONTROL_DB, projectId)) return json({ error: "project not found" }, 404, id);
      return json({ events: await listAudit(env.MISSION_CONTROL_DB, projectId, Number(url.searchParams.get("limit") || 50)) }, 200, id);
    }
    if (request.method === "GET" && parts[3] === "events") {
      if (!adminAuthorized(request, env)) return adminFailure(id);
      if (!await projectExists(env.MISSION_CONTROL_DB, projectId)) return json({ error: "project not found" }, 404, id);
      const objectId = env.PROJECT_EVENTS.idFromName(projectId);
      return env.PROJECT_EVENTS.get(objectId).fetch(new Request("https://events.internal/connect", request));
    }
    if (request.method === "GET" && parts.length === 3) {
      if (!adminAuthorized(request, env)) return adminFailure(id);
      const project = await getProject(env.MISSION_CONTROL_DB, projectId);
      return project ? json({ project }, 200, id) : json({ error: "project not found" }, 404, id);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/agents/register") {
    if (!adminAuthorized(request, env)) return adminFailure(id);
    const input = parseAgentRegistration(await readJson(request)) as AgentRegistrationInput;
    if (!await projectExists(env.MISSION_CONTROL_DB, input.project_id)) return json({ error: "project not found" }, 404, id);
    const token = `mc_${crypto.randomUUID().replaceAll("-", "")}`;
    const created = await createAgent(env.MISSION_CONTROL_DB, input, await sha256(token));
    await audit(env.MISSION_CONTROL_DB, {
      project_id: input.project_id, actor: "operator", event_type: "agent.registered",
      resource_type: "agent", resource_id: created.agent.id, request_id: id,
      payload_json: JSON.stringify({ machine_id: created.machine.id, scopes: input.scopes }),
    });
    return json({ agent: { id: created.agent.id, machine_id: created.machine.id, name: created.agent.name, scopes: input.scopes }, credential: token }, 201, id);
  }

  if (request.method === "POST" && parts[0] === "api" && parts[1] === "agents" && parts[2] && parts[3] === "heartbeat") {
    const auth = request.headers.get("authorization") || "";
    if (!auth.startsWith("Bearer ")) return json({ error: "agent credential required", code: "agent_required" }, 401, id);
    const agent = await authenticateAgent(env.MISSION_CONTROL_DB, await sha256(auth.slice(7).trim()));
    if (!agent) return json({ error: "invalid or revoked agent credential", code: "agent_denied" }, 401, id);
    if (agent.id !== parts[2]) return json({ error: "credential does not own this agent", code: "agent_mismatch" }, 403, id);
    if (!JSON.parse(agent.scopes_json).includes("heartbeat:write")) return json({ error: "heartbeat scope is missing", code: "scope_denied" }, 403, id);
    const heartbeat = parseHeartbeat(await readJson(request));
    try {
      const recorded = await recordHeartbeat(env.MISSION_CONTROL_DB, agent, heartbeat);
      const event = await audit(env.MISSION_CONTROL_DB, {
        project_id: agent.project_id, actor: `agent:${agent.id}`, event_type: "agent.heartbeat",
        resource_type: "agent", resource_id: agent.id, request_id: id,
        occurred_at: heartbeat.observed_at,
        payload_json: JSON.stringify({ heartbeat_id: recorded.heartbeatId, machine_id: recorded.machineId, status: heartbeat.status }),
      });
      await publish(env, agent.project_id, { type: event.event_type, occurred_at: event.occurred_at, resource_id: event.resource_id, payload: JSON.parse(event.payload_json) });
      return json({ accepted: true, heartbeat_id: recorded.heartbeatId, observed_at: heartbeat.observed_at }, 202, id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("unique")) return json({ error: "heartbeat nonce already used", code: "replayed_heartbeat" }, 409, id);
      throw error;
    }
  }

  return json({ error: "not found" }, 404, id);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (new URL(request.url).pathname.startsWith("/api/")) return await handleApi(request, env);
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof ProtocolError) return json({ error: error.message, code: error.code }, error.status);
      console.error(error);
      return json({ error: "internal server error", code: "internal_error" }, 500);
    }
  },
};
