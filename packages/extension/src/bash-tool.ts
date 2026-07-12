import { createBashTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAdapterRuntime,
  executeDetachableBash,
  resolveGroupIdentity,
  type ToolResultLike,
} from "@davecodes/pi-background-work-sdk";

/**
 * Register a promotion-capable Bash tool for stock Pi installs.
 *
 * Pi resolves the effective `bash` tool by registration: the last extension to
 * register wins. This wrapper delegates every execution to Pi's own
 * `createBashTool` implementation (identical behavior, rendering, truncation,
 * process handling) and only adds the detachable race around result delivery.
 *
 * Ownership rules:
 *   - If another extension also owns `bash` (e.g. a UI pack), load order decides
 *     the winner. A losing wrapper is inert — it never intercepts executions.
 *   - Owners that want promotion under their own bash implementation should
 *     integrate `executeDetachableBash` from the SDK instead and set
 *     `bashTool: "off"` in background-work.json to disable this wrapper.
 */
export function registerDetachableBash(pi: ExtensionAPI): void {
  const runtime = createAdapterRuntime(pi, "bash");
  const identity = resolveGroupIdentity();
  const original = createBashTool(process.cwd());
  pi.registerTool({
    ...original,
    async execute(toolCallId, params, signal, onUpdate) {
      // Cast at the SDK boundary only: AgentToolResult satisfies ToolResultLike
      // structurally, but TResult inference needs the concrete tool's type.
      return executeDetachableBash({
        pi,
        adapterInstanceId: runtime.adapterInstanceId,
        sessionId: runtime.sessionId(),
        groupId: identity.groupId,
        toolCallId,
        params: params as { command?: unknown },
        outerSignal: signal,
        onUpdate: onUpdate as (partial: ToolResultLike) => void,
        execute: (jobSignal, jobUpdate) =>
          original.execute(toolCallId, params, jobSignal, jobUpdate as never) as Promise<ToolResultLike>,
      }) as never;
    },
  });
}
