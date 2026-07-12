# @davecodes/pi-background-work-sdk

Protocol types and adapter SDK for [pi-background-work](https://github.com/Davidcreador/pi-background-work) — promote already-running foreground Pi tool executions into background jobs.

Use this package when your extension owns a Pi tool whose executions should be promotable via `/background`. The coordinator (shipped by the `pi-background-work` extension) discovers adapters over the Pi event bus; this SDK implements the adapter side with the exactly-once promotion race built in.

```ts
import { createAdapterRuntime, runDetachable } from "@davecodes/pi-background-work-sdk";

const runtime = createAdapterRuntime(pi, "my-tool");

// inside your tool's execute():
return runDetachable({
  pi,
  adapterInstanceId: runtime.adapterInstanceId,
  sessionId: runtime.sessionId(),
  toolCallId,
  toolName: "my-tool",
  kind: "shell",
  label,
  mutationRisk: "unknown",
  outerSignal: signal,
  onUpdate,
  textOf: (partial) => extractText(partial),
  execute: runOriginalExactlyOnce,
  completionOf: (outcome, ctx) => ({ status: "succeeded", summary: "done", output: "..." }),
  promotedResult: (jobId) => placeholderResultFor(jobId),
});
```

Guarantees the runner enforces:

- The execution runs exactly once; promotion only changes who receives the already-running promise.
- Foreground updates stop permanently after promotion.
- Outer aborts apply only while foreground; the coordinator owns cancellation afterwards.
- A throwing `completionOf` settles as a failed completion — never an unhandled rejection.

Also exported: `executeDetachableBash` (bash-owner helper), `commandRisk` (conservative shell mutation classifier), protocol constants/types (`./protocol` subpath), and identity helpers (`sessionIdFrom`, `jobIdFor`, `resolveGroupIdentity`).

No runtime dependencies; the Pi API is typed structurally. Works without the coordinator installed — registrations are simply never promoted.
