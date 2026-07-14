import type { BackgroundEventEmitter } from "./identity.ts";
import { commandRisk } from "./mutation-risk.ts";
import { runDetachable } from "./run-detachable.ts";

/** Structural view of a Pi tool result — avoids a hard dependency on the Pi package. */
export interface ToolResultLike {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

function resultText(result: ToolResultLike): string {
  return result.content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
}

function failed(result: ToolResultLike): boolean {
  return Boolean((result as ToolResultLike & { isError?: boolean }).isError);
}

/** Pi's bash tool reports timeouts as text, not typed errors; match both known phrasings. */
function timedOut(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value ?? "");
  return /(?:^timeout:|Command timed out after\s+\S+\s+seconds)/i.test(message);
}

export interface DetachableBashInput<TResult extends ToolResultLike> {
  pi: BackgroundEventEmitter;
  adapterInstanceId: string;
  sessionId: string;
  groupId?: string;
  toolCallId: string;
  params: { command?: unknown };
  outerSignal?: AbortSignal;
  onUpdate?: (partial: TResult) => void;
  execute(signal: AbortSignal, onUpdate: (partial: TResult) => void): Promise<TResult>;
}

/**
 * Execute an existing Bash tool once, racing only its result delivery against
 * an atomic promotion gate. Use from whichever extension owns the effective
 * `bash` tool — the execution and its process group stay under that owner.
 */
export async function executeDetachableBash<TResult extends ToolResultLike>(
  input: DetachableBashInput<TResult>,
): Promise<TResult> {
  const command = String(input.params.command ?? "");
  return runDetachable<TResult>({
    pi: input.pi,
    adapterInstanceId: input.adapterInstanceId,
    sessionId: input.sessionId,
    groupId: input.groupId,
    toolCallId: input.toolCallId,
    toolName: "bash",
    kind: "shell",
    label: command.replaceAll("\n", " ").slice(0, 160),
    mutationRisk: commandRisk(command),
    outerSignal: input.outerSignal,
    onUpdate: input.onUpdate,
    textOf: resultText,
    execute: input.execute,
    completionOf(outcome, context) {
      if (!outcome.ok) {
        const status = context.aborted ? "cancelled" as const : timedOut(outcome.error) ? "timed-out" as const : "failed" as const;
        return {
          status,
          summary: status === "timed-out" ? "Shell command timed out." : "Shell command failed.",
          error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        };
      }
      const output = resultText(outcome.result);
      const details = outcome.result.details as { fullOutputPath?: string } | undefined;
      const status = context.aborted ? "cancelled" as const
        : timedOut(output) ? "timed-out" as const
          : failed(outcome.result) ? "failed" as const : "succeeded" as const;
      return {
        status,
        summary: status === "timed-out" ? "Shell command timed out."
          : status === "failed" ? "Shell command exited unsuccessfully." : "Shell command completed.",
        output,
        artifactPath: details?.fullOutputPath,
      };
    },
    promotedResult: (jobId) => ({
      content: [{ type: "text", text: `Backgrounded as ${jobId} at the user's request. The result will be delivered to you automatically in a later message when the command finishes — do not wait, sleep, poll, or re-run it. Finish any unrelated work and end your turn so the user can keep chatting.` }],
      details: { backgroundWork: { jobId, state: "background" } },
    }) as TResult,
  });
}
