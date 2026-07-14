# pi-background-work

Promote already-running foreground work in [Pi](https://github.com/badlogic/pi-mono) into session-bound background jobs — then get notified and auto-resume when it finishes.

Type `/background` while a shell command or subagent run is executing: the original execution keeps running exactly once (never restarted, never duplicated), Pi gets its turn back immediately, and the completion is delivered as a custom message when the agent is idle.

```
foreground-running ──► completed                    (normal tool result)
        └────────────► promoted ──► completed       (background job + notification)
                                └──► cancelling ──► cancelled
```

## Install

```bash
pi install npm:pi-background-work
```

One package registers everything:

1. **Coordinator** — `/background`, `/background-jobs`, `/background-doctor`, completion delivery, cancellation, session/reload safety, group isolation, mutation warnings.
2. **Detachable Bash** — wraps Pi's stock `bash` tool with a promotion gate. Identical execution semantics; only result delivery is raceable.
3. **Bundled subagents** — [`@davecodes/pi-subagents`](../pi-subagents), a fork of [pi-subagents](https://github.com/nicobailon/pi-subagents) with top-level foreground-run promotion (single, parallel, and chain runs). **Replaces** a standalone `npm:pi-subagents` entry — remove that entry from your settings to avoid double tool registration.

## Configuration

`~/.pi/agent/background-work.json` (all optional):

```json
{
  "enabled": true,
  "shortcut": null,
  "completionBehavior": "notify-and-resume",
  "completionDebounceMs": 200,
  "maxOutputBytes": 51200,
  "maxOutputLines": 2000,
  "mutationWarnings": true,
  "statusIndicator": true,
  "promotionYield": "interrupt",
  "bashTool": "wrap",
  "subagents": true
}
```

- `shortcut` — optional key (e.g. `"f12"`) to promote all active work. No default; conflicts with effective Pi keybindings are detected and refused.
- `statusIndicator` — live footer indicator while background work exists: `↳ ⠼ 2 background · 3m12s` (spinner, job count, oldest-job elapsed) plus `✓ N done` for completions still awaiting delivery/acknowledgement. Clears automatically when everything drains.
- `completionBehavior` — `notify-and-resume` triggers a turn on completion; `notify-only` just queues the message.
- `promotionYield` — how promotion hands control back to you. The placeholder tool result only *asks* the model to stop; models tend to babysit the job with wait/poll loops. `"interrupt"` (default) ends the streaming turn like ESC — promoted jobs survive. `"steer"` queues an explicit yield instruction into the running turn. `"off"` relies on the placeholder text alone.
- `bashTool: "off"` — leave the effective Bash tool alone (use when another extension owns `bash` and integrates the SDK itself).
- `subagents: false` — don't register the bundled subagent tool (e.g. you run upstream `pi-subagents` and don't need subagent promotion).

Group isolation for orchestrators: export `PI_BACKGROUND_WORK_GROUP_ID` (and optionally `PI_BACKGROUND_WORK_ROLE`) so completions from one mission never leak into a reused session serving another. `AGENT_HARNESS_MISSION_ID` / `AGENT_HARNESS_ROLE` are honored as aliases.

## Guarantees

- **Exactly-once execution.** Promotion is an atomic compare-and-swap against natural completion; there is no restart path.
- **Cancellation ownership.** Outer aborts (interrupt/timeout) apply only while foreground; after promotion the coordinator owns cancellation. Promoted subagent cancellation signals the whole process group.
- **Completion at idle seams.** Delivery waits behind user input and blocking supervisor work; a `context`-acknowledged handshake prevents duplicates, with explicit `/background-jobs` retry for the ambiguous case.
- **Hostile-adapter containment.** The coordinator snapshots identity at registration; adapter mutation, throwing inspectors, and forged completions cannot corrupt bookkeeping.
- **Session-bound.** Jobs never survive Pi exit; `/reload` preserves them exactly once; session switch/fork prompts to cancel.
- **Process-group trade-off.** Foreground subagent runs are spawned `detached` on Unix so promoted cancellation can kill the entire process tree. Consequence: terminal-generated `SIGINT` (Ctrl+C) no longer reaches those children directly — all termination flows through explicit signalling — and a `SIGKILL`ed Pi can orphan a running subagent tree. Graceful shutdown paths cancel everything.

## Packages

| Package | Purpose |
|---|---|
| [`pi-background-work`](packages/extension) | The installable extension (coordinator + bash wrapper + bundled subagents). |
| [`@davecodes/pi-background-work-sdk`](packages/sdk) | Protocol types + adapter SDK (`runDetachable`, `executeDetachableBash`) for tool owners that want promotion under their own tool implementations. |
| [`@davecodes/pi-subagents`](https://github.com/nicobailon/pi-subagents) (separate repo, dependency) | pi-subagents fork adding foreground-run promotion. Kept diff-minimal for upstream rebases; the integration seam is proposed upstream. |

## Integrating your own tool

If your extension owns a tool whose executions should be promotable:

```ts
import { createAdapterRuntime, runDetachable } from "@davecodes/pi-background-work-sdk";

const runtime = createAdapterRuntime(pi, "my-tool");
// inside execute():
return runDetachable({
  pi, adapterInstanceId: runtime.adapterInstanceId, sessionId: runtime.sessionId(),
  toolCallId, toolName: "my-tool", kind: "shell", label, mutationRisk: "unknown",
  outerSignal: signal, onUpdate, textOf, execute: runOriginalOnce,
  completionOf, promotedResult,
});
```

The coordinator treats every adapter as untrusted; your execution keeps running under your ownership either way.

## Development

```bash
npm install          # workspaces; expects ../pi-subagents checkout for the file: dep
npm test             # sdk + extension suites (includes real-bash integration)
npm run typecheck
```

The fork dependency resolves from npm (`@davecodes/pi-subagents`). For fork development, temporarily point it at a local checkout with `file:`.
