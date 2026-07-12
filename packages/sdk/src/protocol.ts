/**
 * Wire protocol between background-work adapters (tool owners) and the
 * coordinator extension. Version 1 travels over the Pi extension event bus:
 * adapters emit `register`/`unregister`; the coordinator emits `state`.
 *
 * The event payloads are treated as hostile by the coordinator: identity is
 * snapshotted at registration and adapter callbacks are wrapped. Adapters must
 * treat `promote()` as an atomic compare-and-swap — after it returns
 * `{ promoted: true }`, the foreground caller receives a placeholder result and
 * the adapter must stop emitting foreground updates.
 */
export const BACKGROUND_WORK_PROTOCOL_VERSION = 1 as const;
export const BACKGROUND_WORK_REGISTER_EVENT = "background-work:v1:register";
export const BACKGROUND_WORK_UNREGISTER_EVENT = "background-work:v1:unregister";
export const BACKGROUND_WORK_STATE_EVENT = "background-work:v1:state";
export const BACKGROUND_WORK_ADAPTER_READY_EVENT = "background-work:v1:adapter-ready";
export const BACKGROUND_WORK_SUPERVISOR_STATE_EVENT = "background-work:v1:supervisor-state";
export const BACKGROUND_WORK_COMPLETION_TYPE = "background-work-completion";

export type BackgroundJobKind = "shell" | "subagent";
export type MutationRisk = "read-only" | "mutating" | "unknown";
export type BackgroundJobTerminalStatus = "succeeded" | "failed" | "timed-out" | "cancelled";
export type BackgroundJobState = "foreground-running" | "background-running" | "cancelling" | BackgroundJobTerminalStatus;

export interface BackgroundJobSnapshot {
  jobId: string;
  sessionId: string;
  /** Optional isolation scope (e.g. an orchestrator mission). Jobs from a foreign group are rejected. */
  groupId?: string;
  toolCallId: string;
  toolName: string;
  kind: BackgroundJobKind;
  label: string;
  startedAt: number;
  promotedAt?: number;
  finishedAt?: number;
  state: BackgroundJobState;
  mutationRisk: MutationRisk;
  latestOutput?: string;
  artifactPath?: string;
  error?: string;
}

export interface BackgroundJobCompletion {
  jobId: string;
  status: BackgroundJobTerminalStatus;
  finishedAt: number;
  durationMs: number;
  summary: string;
  output?: string;
  artifactPath?: string;
  error?: string;
}

export interface DetachableExecution {
  protocolVersion: typeof BACKGROUND_WORK_PROTOCOL_VERSION;
  jobId: string;
  adapterInstanceId: string;
  sessionId: string;
  groupId?: string;
  toolCallId: string;
  toolName: string;
  kind: BackgroundJobKind;
  label: string;
  startedAt: number;
  mutationRisk: MutationRisk;
  /** Atomic promotion gate. Must return `{ promoted: false }` once the execution completed or was already promoted. */
  promote(): { promoted: boolean; jobId: string };
  cancel(): Promise<void> | void;
  inspect(): BackgroundJobSnapshot;
  completion: Promise<BackgroundJobCompletion>;
}

export interface BackgroundWorkUnregisterEvent {
  protocolVersion: typeof BACKGROUND_WORK_PROTOCOL_VERSION;
  jobId: string;
  adapterInstanceId: string;
}

export interface BackgroundWorkStateEvent {
  protocolVersion: typeof BACKGROUND_WORK_PROTOCOL_VERSION;
  sessionId: string;
  groupId?: string;
  role?: string;
  sequence: number;
  activeCount: number;
  riskyCount: number;
  state: "idle" | "background-active";
}

export interface BackgroundWorkTransitionEntry {
  version: typeof BACKGROUND_WORK_PROTOCOL_VERSION;
  sequence: number;
  jobId: string;
  sessionId: string;
  groupId?: string;
  from: BackgroundJobState;
  to: BackgroundJobState;
  at: number;
}
