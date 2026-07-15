import {
  BACKGROUND_WORK_PROTOCOL_VERSION,
  type BackgroundJobCompletion,
  type BackgroundJobSnapshot,
  type BackgroundJobState,
  type BackgroundWorkTransitionEntry,
  type DetachableExecution,
} from "@davecodes/pi-background-work-sdk";

export interface BackgroundWorkStore {
  sessionId: string;
  groupId?: string;
  role?: string;
  generation: number;
  sequence: number;
  stateSequence: number;
  executions: Map<string, DetachableExecution>;
  snapshots: Map<string, BackgroundJobSnapshot>;
  completionAttached: Set<string>;
  cancellations: Map<string, Promise<boolean>>;
  delivered: Set<string>;
  queued: Set<string>;
  queuedDeliveries: Map<string, BackgroundJobCompletion>;
  pendingDeliveries: BackgroundJobCompletion[];
  transitions: BackgroundWorkTransitionEntry[];
  notify?: () => void;
  hooks?: BackgroundJobManagerHooks;
}

export interface BackgroundJobManagerHooks {
  onTransition?(entry: BackgroundWorkTransitionEntry): void;
  onStateChange?(): void;
}

export function createBackgroundWorkStore(): BackgroundWorkStore {
  return {
    sessionId: "",
    generation: 0,
    sequence: 0,
    stateSequence: 0,
    executions: new Map(),
    snapshots: new Map(),
    completionAttached: new Set(),
    cancellations: new Map(),
    delivered: new Set(),
    queued: new Set(),
    queuedDeliveries: new Map(),
    pendingDeliveries: [],
    transitions: [],
  };
}

function isTerminal(state: BackgroundJobState): boolean {
  return state === "succeeded" || state === "failed" || state === "timed-out" || state === "cancelled";
}

function safeErrorText(value: unknown): string {
  try {
    if (value instanceof Error && typeof value.message === "string") return value.message;
    return String(value);
  } catch {
    return "unprintable adapter error";
  }
}

export class BackgroundJobManager {
  constructor(
    readonly store: BackgroundWorkStore,
    hooks: BackgroundJobManagerHooks = {},
    private readonly cancellationTimeoutMs = 10_000,
  ) {
    store.cancellations ??= new Map();
    store.hooks = hooks;
  }

  setSession(input: { sessionId: string; groupId?: string; role?: string; preserveJobs?: boolean }): void {
    // Only an explicit reload transfer may retain live closures. Startup/new/resume must reset even when an ephemeral ID repeats.
    if (!input.preserveJobs && this.store.sessionId) this.reset();
    this.store.sessionId = input.sessionId;
    this.store.groupId = input.groupId;
    this.store.role = input.role;
    this.store.generation += 1;
    this.store.hooks?.onStateChange?.();
  }

  register(execution: DetachableExecution): { accepted: boolean; reason?: string } {
    if (execution.protocolVersion !== BACKGROUND_WORK_PROTOCOL_VERSION) return { accepted: false, reason: "unsupported protocol version" };
    if (!execution.jobId || !execution.toolCallId || !execution.adapterInstanceId) return { accepted: false, reason: "missing stable execution identity" };
    if (this.store.sessionId && execution.sessionId !== this.store.sessionId) return { accepted: false, reason: "session mismatch" };
    if (execution.groupId !== this.store.groupId) return { accepted: false, reason: "group mismatch" };
    const existing = this.store.executions.get(execution.jobId);
    if (existing && existing.adapterInstanceId !== execution.adapterInstanceId) return { accepted: false, reason: "job id already owned by another adapter" };
    if (existing) return { accepted: true };

    let inspected: BackgroundJobSnapshot;
    try {
      const live = execution.inspect();
      if (!live || typeof live !== "object") return { accepted: false, reason: "adapter inspect returned invalid snapshot" };
      // Read only advisory diagnostics while still inside the hostile-adapter
      // boundary. Identity and state come from the accepted handle below.
      inspected = {
        jobId: execution.jobId,
        sessionId: execution.sessionId,
        groupId: execution.groupId,
        toolCallId: execution.toolCallId,
        toolName: execution.toolName,
        kind: execution.kind,
        label: execution.label,
        startedAt: execution.startedAt,
        state: "foreground-running",
        mutationRisk: execution.mutationRisk,
        latestOutput: typeof live.latestOutput === "string" ? live.latestOutput.slice(-50 * 1024) : undefined,
        artifactPath: typeof live.artifactPath === "string" ? live.artifactPath : undefined,
        error: typeof live.error === "string" ? live.error : undefined,
      };
    } catch (error) {
      return { accepted: false, reason: `adapter inspect failed: ${safeErrorText(error)}` };
    }
    // Adapter objects remain mutable after registration. Capture the accepted identity and
    // completion promise so later adapter mutation cannot redirect coordinator bookkeeping.
    const registered: DetachableExecution = {
      protocolVersion: execution.protocolVersion,
      jobId: execution.jobId,
      adapterInstanceId: execution.adapterInstanceId,
      sessionId: execution.sessionId,
      groupId: execution.groupId,
      toolCallId: execution.toolCallId,
      toolName: execution.toolName,
      kind: execution.kind,
      label: execution.label,
      startedAt: execution.startedAt,
      mutationRisk: execution.mutationRisk,
      promote: () => execution.promote(),
      cancel: () => execution.cancel(),
      inspect: () => execution.inspect(),
      completion: execution.completion,
    };
    this.store.executions.set(registered.jobId, registered);
    this.store.snapshots.set(registered.jobId, inspected);
    this.attachCompletion(registered);
    this.store.hooks?.onStateChange?.();
    return { accepted: true };
  }

  unregister(jobId: string, adapterInstanceId: string): void {
    const execution = this.store.executions.get(jobId);
    if (!execution || execution.adapterInstanceId !== adapterInstanceId) return;
    const snapshot = this.store.snapshots.get(jobId);
    if (snapshot?.state === "foreground-running") {
      this.store.executions.delete(jobId);
      this.store.snapshots.delete(jobId);
      this.store.completionAttached.delete(jobId);
      this.store.hooks?.onStateChange?.();
    }
  }

  promoteAll(now = Date.now()): BackgroundJobSnapshot[] {
    const promoted: BackgroundJobSnapshot[] = [];
    for (const [jobId, execution] of this.store.executions) {
      const snapshot = this.store.snapshots.get(jobId);
      if (!snapshot || snapshot.state !== "foreground-running") continue;
      let result: { promoted: boolean; jobId: string };
      try { result = execution.promote(); }
      catch { continue; }
      if (!result?.promoted || result.jobId !== jobId) continue;
      const next = { ...snapshot, state: "background-running" as const, promotedAt: now };
      this.store.snapshots.set(jobId, next);
      this.recordTransition(snapshot.state, next.state, next, now);
      promoted.push(next);
    }
    if (promoted.length) this.store.hooks?.onStateChange?.();
    return promoted;
  }

  async cancel(jobId: string): Promise<boolean> {
    const inFlight = this.store.cancellations.get(jobId);
    if (inFlight) return inFlight;
    const execution = this.store.executions.get(jobId);
    const snapshot = this.store.snapshots.get(jobId);
    if (!execution || !snapshot || isTerminal(snapshot.state)) return false;

    const cancellation = Promise.resolve().then(async () => {
      const current = this.store.snapshots.get(jobId);
      if (!current || isTerminal(current.state)) return false;
      if (current.state !== "cancelling") {
        // Intentionally no transition entry for → cancelling: only terminal
        // outcomes are persisted, and settle() records the terminal transition
        // as coming from "background-running" so history shows one lifecycle
        // edge per job regardless of how cancellation raced completion.
        this.store.snapshots.set(jobId, { ...current, state: "cancelling" });
        this.store.hooks?.onStateChange?.();
      }
      const settled = Promise.resolve()
        .then(() => execution.cancel())
        .then(() => execution.completion);
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          settled,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error(`Timed out cancelling ${jobId} after ${this.cancellationTimeoutMs}ms`)), this.cancellationTimeoutMs);
            timeout.unref?.();
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      return true;
    });
    this.store.cancellations.set(jobId, cancellation);
    try {
      return await cancellation;
    } catch (error) {
      const current = this.store.snapshots.get(jobId);
      if (current?.state === "cancelling") {
        this.store.snapshots.set(jobId, { ...current, state: current.promotedAt === undefined ? "foreground-running" : "background-running" });
        this.store.hooks?.onStateChange?.();
      }
      throw error;
    } finally {
      if (this.store.cancellations.get(jobId) === cancellation) this.store.cancellations.delete(jobId);
    }
  }

  async cancelAll(includeForeground = false): Promise<{ cancelled: string[]; failed: Array<{ jobId: string; error: string }> }> {
    const cancelled: string[] = [];
    const failed: Array<{ jobId: string; error: string }> = [];
    const snapshots = includeForeground
      ? this.allSnapshots().filter((snapshot) => !isTerminal(snapshot.state))
      : this.activeSnapshots();
    await Promise.all(snapshots.map(async (snapshot) => {
      try {
        if (await this.cancel(snapshot.jobId)) cancelled.push(snapshot.jobId);
      } catch (error) {
        failed.push({ jobId: snapshot.jobId, error: error instanceof Error ? error.message : String(error) });
      }
    }));
    return { cancelled, failed };
  }

  activeSnapshots(): BackgroundJobSnapshot[] {
    return [...this.store.snapshots.values()]
      .filter((snapshot) => snapshot.state === "background-running" || snapshot.state === "cancelling")
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  detachableSnapshots(): BackgroundJobSnapshot[] {
    return [...this.store.snapshots.values()]
      .filter((snapshot) => snapshot.state === "foreground-running")
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  allSnapshots(): BackgroundJobSnapshot[] {
    for (const jobId of this.store.executions.keys()) this.refreshSnapshot(jobId);
    return [...this.store.snapshots.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  riskyActiveSnapshots(): BackgroundJobSnapshot[] {
    return this.activeSnapshots().filter((snapshot) => snapshot.mutationRisk !== "read-only");
  }

  markQueued(jobIds: string[]): void {
    for (const jobId of jobIds) {
      const completion = this.store.pendingDeliveries.find((item) => item.jobId === jobId);
      if (completion) this.store.queuedDeliveries.set(jobId, completion);
      this.store.queued.add(jobId);
    }
    this.store.pendingDeliveries = this.store.pendingDeliveries.filter((completion) => !this.store.queued.has(completion.jobId));
    // Delivery-state changes are state changes: the footer indicator tracks
    // pending/queued counts, not just running jobs.
    this.store.hooks?.onStateChange?.();
  }

  retryQueued(jobId: string): boolean {
    const completion = this.store.queuedDeliveries.get(jobId);
    if (!completion || this.store.delivered.has(jobId)) return false;
    this.store.queued.delete(jobId);
    this.store.queuedDeliveries.delete(jobId);
    this.store.pendingDeliveries.push(completion);
    return true;
  }

  markDelivered(jobIds: string[]): void {
    const pending = new Set(this.store.pendingDeliveries.map((completion) => completion.jobId));
    const delivered = new Set(jobIds.filter((jobId) => this.store.queued.has(jobId) || this.store.queuedDeliveries.has(jobId) || pending.has(jobId)));
    if (!delivered.size) return;
    for (const jobId of delivered) {
      this.store.queued.delete(jobId);
      this.store.queuedDeliveries.delete(jobId);
      this.store.delivered.add(jobId);
    }
    this.store.pendingDeliveries = this.store.pendingDeliveries.filter((completion) => !delivered.has(completion.jobId));
    this.store.hooks?.onStateChange?.();
  }

  reset(): void {
    this.store.executions.clear();
    this.store.snapshots.clear();
    this.store.completionAttached.clear();
    this.store.cancellations.clear();
    this.store.delivered.clear();
    this.store.queued.clear();
    this.store.queuedDeliveries.clear();
    this.store.pendingDeliveries = [];
    this.store.transitions = [];
    this.store.sequence = 0;
    this.store.hooks?.onStateChange?.();
  }

  private attachCompletion(execution: DetachableExecution): void {
    if (this.store.completionAttached.has(execution.jobId)) return;
    this.store.completionAttached.add(execution.jobId);
    void execution.completion.then(
      (value) => {
        let completion: BackgroundJobCompletion;
        try {
          completion = this.normalizeCompletion(execution, value);
        } catch (error) {
          completion = this.failedCompletion(execution, "Background execution returned a malformed completion.", error);
        }
        this.settle(execution, completion);
      },
      (error) => this.settle(execution, this.failedCompletion(execution, "Background execution failed before producing a completion result.", error)),
    );
  }

  private failedCompletion(execution: DetachableExecution, summary: string, error: unknown): BackgroundJobCompletion {
    let message = "Unknown adapter error";
    try {
      const candidate = error instanceof Error ? error.message : error;
      message = typeof candidate === "string" ? candidate : String(candidate);
    } catch { /* hostile coercion is untrusted */ }
    return {
      jobId: execution.jobId,
      status: "failed",
      finishedAt: Date.now(),
      durationMs: Math.max(0, Date.now() - execution.startedAt),
      summary,
      error: message,
    };
  }

  private normalizeCompletion(execution: DetachableExecution, value: BackgroundJobCompletion): BackgroundJobCompletion {
    const raw = value && typeof value === "object" ? value as BackgroundJobCompletion : {} as BackgroundJobCompletion;
    const status = raw.status === "succeeded" || raw.status === "failed" || raw.status === "timed-out" || raw.status === "cancelled" ? raw.status : "failed";
    const stringValue = (input: unknown): string | undefined => typeof input === "string" ? input : input == null ? undefined : String(input);
    const finishedAt = raw.finishedAt;
    const durationMs = raw.durationMs;
    return {
      jobId: execution.jobId,
      status,
      finishedAt: Number.isFinite(finishedAt) ? finishedAt : Date.now(),
      durationMs: Number.isFinite(durationMs) ? Math.max(0, durationMs) : Math.max(0, Date.now() - execution.startedAt),
      summary: stringValue(raw.summary) ?? "Background execution returned an invalid completion.",
      output: stringValue(raw.output), artifactPath: stringValue(raw.artifactPath), error: stringValue(raw.error),
    };
  }

  private settle(execution: DetachableExecution, completion: BackgroundJobCompletion): void {
    const snapshot = this.store.snapshots.get(execution.jobId);
    if (!snapshot) return;
    this.store.executions.delete(execution.jobId);
    if (execution.groupId !== this.store.groupId || snapshot.groupId !== this.store.groupId) {
      this.store.snapshots.delete(execution.jobId);
      this.store.completionAttached.delete(execution.jobId);
      this.store.hooks?.onStateChange?.();
      return;
    }
    if (snapshot.state === "foreground-running" || (snapshot.state === "cancelling" && snapshot.promotedAt === undefined)) {
      this.store.snapshots.delete(execution.jobId);
      this.store.completionAttached.delete(execution.jobId);
      this.store.hooks?.onStateChange?.();
      return;
    }
    if (isTerminal(snapshot.state)) return;
    this.refreshSnapshot(execution.jobId);
    const refreshed = this.store.snapshots.get(execution.jobId) ?? snapshot;
    const next: BackgroundJobSnapshot = {
      ...refreshed,
      jobId: execution.jobId,
      sessionId: execution.sessionId,
      groupId: execution.groupId,
      toolCallId: execution.toolCallId,
      toolName: execution.toolName,
      kind: execution.kind,
      state: completion.status,
      finishedAt: completion.finishedAt,
      latestOutput: completion.output,
      artifactPath: completion.artifactPath,
      error: completion.error,
    };
    this.store.snapshots.set(execution.jobId, next);
    this.recordTransition(snapshot.state === "cancelling" ? "background-running" : snapshot.state, next.state, next, completion.finishedAt);
    if (!this.store.delivered.has(completion.jobId) && !this.store.queued.has(completion.jobId) && !this.store.pendingDeliveries.some((item) => item.jobId === completion.jobId)) {
      this.store.pendingDeliveries.push(completion);
    }
    this.store.hooks?.onStateChange?.();
    this.store.notify?.();
  }

  private refreshSnapshot(jobId: string): void {
    const execution = this.store.executions.get(jobId);
    const current = this.store.snapshots.get(jobId);
    if (!execution || !current) return;
    try {
      const live = execution.inspect();
      // Adapter inspection is untrusted for identity/state. Only bounded diagnostic
      // fields refresh, and only when they are plain strings — a hostile object with
      // a throwing toString() must not reach notify/template rendering later.
      this.store.snapshots.set(jobId, {
        ...current,
        latestOutput: typeof live.latestOutput === "string" ? live.latestOutput.slice(-50 * 1024) : current.latestOutput,
        artifactPath: typeof live.artifactPath === "string" ? live.artifactPath : current.artifactPath,
        error: typeof live.error === "string" ? live.error : current.error,
      });
    } catch {
      // Inspection is advisory; never let a broken adapter corrupt coordinator state.
    }
  }

  private recordTransition(from: BackgroundJobState, to: BackgroundJobState, snapshot: BackgroundJobSnapshot, at: number): void {
    const entry: BackgroundWorkTransitionEntry = {
      version: BACKGROUND_WORK_PROTOCOL_VERSION,
      sequence: ++this.store.sequence,
      jobId: snapshot.jobId,
      sessionId: snapshot.sessionId,
      groupId: snapshot.groupId,
      from,
      to,
      at,
    };
    this.store.transitions.push(entry);
    this.store.hooks?.onTransition?.(entry);
  }
}
