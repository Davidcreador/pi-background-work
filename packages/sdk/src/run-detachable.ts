import { jobIdFor } from "./identity.ts";
import type { BackgroundEventEmitter } from "./identity.ts";
import {
  BACKGROUND_WORK_PROTOCOL_VERSION,
  BACKGROUND_WORK_REGISTER_EVENT,
  BACKGROUND_WORK_UNREGISTER_EVENT,
  type BackgroundJobCompletion,
  type BackgroundJobKind,
  type BackgroundJobTerminalStatus,
  type MutationRisk,
} from "./protocol.ts";

export type DetachableOutcome<TResult> =
  | { ok: true; result: TResult }
  | { ok: false; error: unknown };

export interface DetachableCompletionContext {
  jobId: string;
  startedAt: number;
  finishedAt: number;
  /** True when the execution's own signal aborted (cancellation), regardless of outcome shape. */
  aborted: boolean;
}

export interface DetachableRunInput<TResult> {
  pi: BackgroundEventEmitter;
  adapterInstanceId: string;
  sessionId: string;
  groupId?: string;
  toolCallId: string;
  toolName: string;
  kind: BackgroundJobKind;
  label: string;
  mutationRisk: MutationRisk;
  /** The tool host's outer abort signal. Forwarded only while foreground; promotion transfers cancellation ownership to the coordinator. */
  outerSignal?: AbortSignal;
  /** Foreground streaming callback. Silenced permanently after promotion. */
  onUpdate?: (partial: TResult) => void;
  /** Extract display text from a (partial) result for live inspection. */
  textOf(partial: TResult): string;
  /** Run the original execution exactly once. Must respect the provided signal. */
  execute(signal: AbortSignal, onUpdate: (partial: TResult) => void): Promise<TResult>;
  /** Map the settled outcome to completion fields. Runner supplies identity and timing. */
  completionOf(outcome: DetachableOutcome<TResult>, context: DetachableCompletionContext): {
    status: BackgroundJobTerminalStatus;
    summary: string;
    output?: string;
    artifactPath?: string;
    error?: string;
  };
  /** Placeholder result returned to the foreground caller when the run is promoted. */
  promotedResult(jobId: string): TResult;
  /** Optional cancellation reason (e.g. a tagged hard-cancel error). */
  cancelReason?(): unknown;
  /** Optional signal decoration for executions that need promotion-aware metadata on the signal object. */
  decorateSignal?(signal: AbortSignal): AbortSignal;
  /** Invoked exactly once when promotion wins the race, before the placeholder is returned. */
  onPromoted?(): void;
}

/**
 * Execute a tool exactly once while racing its result delivery against an
 * atomic promotion gate. Natural completion and promotion have exactly one
 * winner:
 *
 *   foreground-running ──► completed            (result returned normally)
 *           └────────────► promoted ──► completed (coordinator owns delivery)
 *
 * The execution itself is never restarted or duplicated — promotion only
 * changes who receives the already-running promise.
 */
export async function runDetachable<TResult>(input: DetachableRunInput<TResult>): Promise<TResult> {
  const startedAt = Date.now();
  const jobId = jobIdFor(input.sessionId, input.groupId, input.toolCallId);
  let latestOutput: string | undefined;
  const controller = new AbortController();
  const signal = input.decorateSignal ? input.decorateSignal(controller.signal) : controller.signal;
  let phase: "foreground" | "promoted" | "completed" = "foreground";
  let promoteResolve!: () => void;
  const promoted = new Promise<void>((resolve) => { promoteResolve = resolve; });

  // Outer aborts (user interrupt, tool timeout wrapper) apply only while the
  // run is foreground. After promotion the coordinator owns cancellation.
  const forwardAbort = () => { if (phase === "foreground") controller.abort(input.outerSignal?.reason); };
  if (input.outerSignal?.aborted) forwardAbort();
  else input.outerSignal?.addEventListener("abort", forwardAbort, { once: true });

  const outcome = input.execute(signal, (partial) => {
    latestOutput = input.textOf(partial).slice(-50 * 1024);
    if (phase === "foreground") input.onUpdate?.(partial);
  }).then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  const completion: Promise<BackgroundJobCompletion> = outcome.then((settled) => {
    const finishedAt = Date.now();
    // completionOf is adapter-author code. Map its failures to a failed
    // completion instead of rejecting: with no coordinator installed nothing
    // would handle the rejection, and an unhandled-rejection warning in the
    // host process must never be the cost of an optional integration.
    try {
      const fields = input.completionOf(settled, { jobId, startedAt, finishedAt, aborted: controller.signal.aborted });
      return { jobId, finishedAt, durationMs: finishedAt - startedAt, ...fields };
    } catch (error) {
      return {
        jobId,
        status: "failed" as const,
        finishedAt,
        durationMs: finishedAt - startedAt,
        summary: "Adapter completion mapping failed.",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const inspect = () => ({
    jobId,
    sessionId: input.sessionId,
    groupId: input.groupId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    kind: input.kind,
    label: input.label,
    startedAt,
    state: phase === "promoted" ? "background-running" as const : "foreground-running" as const,
    mutationRisk: input.mutationRisk,
    latestOutput,
  });

  input.pi.events.emit(BACKGROUND_WORK_REGISTER_EVENT, {
    protocolVersion: BACKGROUND_WORK_PROTOCOL_VERSION,
    adapterInstanceId: input.adapterInstanceId,
    ...inspect(),
    promote() {
      if (phase !== "foreground") return { promoted: false, jobId };
      phase = "promoted";
      input.outerSignal?.removeEventListener("abort", forwardAbort);
      input.onPromoted?.();
      promoteResolve();
      return { promoted: true, jobId };
    },
    cancel() {
      controller.abort(input.cancelReason ? input.cancelReason() : new Error("Background job cancelled"));
    },
    inspect,
    completion,
  });

  const winner = await Promise.race([
    outcome.then((value) => ({ type: "outcome" as const, value })),
    promoted.then(() => ({ type: "promoted" as const })),
  ]);
  if (winner.type === "promoted") return input.promotedResult(jobId);

  phase = "completed";
  input.outerSignal?.removeEventListener("abort", forwardAbort);
  input.pi.events.emit(BACKGROUND_WORK_UNREGISTER_EVENT, {
    protocolVersion: BACKGROUND_WORK_PROTOCOL_VERSION,
    jobId,
    adapterInstanceId: input.adapterInstanceId,
  });
  if (!winner.value.ok) throw winner.value.error;
  return winner.value.result;
}
