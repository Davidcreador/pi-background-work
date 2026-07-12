import crypto from "node:crypto";
import {
  BACKGROUND_WORK_ADAPTER_READY_EVENT,
  BACKGROUND_WORK_PROTOCOL_VERSION,
} from "./protocol.ts";

/** Minimal structural view of the Pi extension API used by adapters. */
export interface BackgroundEventEmitter {
  events: { emit(name: string, payload: unknown): void };
}

/** Structural view of the lifecycle-capable Pi extension API. */
export interface BackgroundAdapterHost extends BackgroundEventEmitter {
  on(event: "session_start", handler: (event: unknown, ctx: SessionContextLike) => void): void;
}

export interface SessionContextLike {
  sessionManager: { getSessionFile(): string | undefined };
}

/**
 * Group/role identity for job isolation. Orchestrators (e.g. a fleet advisor)
 * export a group id so completions from one mission never leak into a reused
 * session serving another. Harness advisor variables are honored as aliases.
 */
export function resolveGroupIdentity(env: NodeJS.ProcessEnv = process.env): { role?: string; groupId?: string } {
  const role = env.PI_BACKGROUND_WORK_ROLE ?? env.AGENT_HARNESS_ROLE;
  const groupId = env.PI_BACKGROUND_WORK_GROUP_ID ?? env.AGENT_HARNESS_MISSION_ID;
  return { ...(role ? { role } : {}), ...(groupId ? { groupId } : {}) };
}

export function hashId(value: string, length: number): string {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, length);
}

/** Stable session identity shared by coordinator and adapters: hash of the session file path. */
export function sessionIdFrom(ctx: SessionContextLike): string {
  const file = ctx.sessionManager.getSessionFile();
  return file ? hashId(file, 16) : `ephemeral-${process.pid}`;
}

/** Deterministic job id: same session + group + tool call always maps to the same job. */
export function jobIdFor(sessionId: string, groupId: string | undefined, toolCallId: string): string {
  return `bg-${hashId(`${sessionId}:${groupId ?? "ordinary"}:${toolCallId}`, 8)}`;
}

export interface AdapterRuntime {
  adapterInstanceId: string;
  sessionId(): string;
}

/**
 * Keep an adapter's registrations correlated with the coordinator's active Pi
 * session, and announce runtime readiness so `/background-doctor` can report
 * which tools actually loaded a promotion-capable adapter.
 */
export function createAdapterRuntime(pi: BackgroundAdapterHost, toolName: string): AdapterRuntime {
  const adapterInstanceId = crypto.randomUUID();
  let activeSessionId = `ephemeral-${process.pid}`;
  const ready = () => pi.events?.emit(BACKGROUND_WORK_ADAPTER_READY_EVENT, {
    protocolVersion: BACKGROUND_WORK_PROTOCOL_VERSION,
    toolName,
    adapterInstanceId,
  });
  ready();
  pi.on("session_start", (_event, ctx) => { activeSessionId = sessionIdFrom(ctx); ready(); });
  return { adapterInstanceId, sessionId: () => activeSessionId };
}
