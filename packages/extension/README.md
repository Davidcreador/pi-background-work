# pi-background-work

Promote already-running foreground work in Pi into session-bound background jobs.

```bash
pi install npm:pi-background-work
```

Type `/background` while a shell command or subagent run executes: the original execution keeps running exactly once, Pi gets its turn back, and the completion is delivered when the agent is idle. By default Pi resumes automatically only if you have not sent another prompt since promotion. The live footer advertises `/background` while eligible work is foreground, then tracks running jobs and undelivered results (`↳ ⠼ 2 background · 3m12s · ✓ 1 done`). Completion messages stay compact until expanded with Pi's tool-expansion key.

Commands: `/background`, `/background-jobs` (live active-first TUI palette with expandable output and direct cancel/retry keys), `/background-config` (edit, repair, and reload), `/background-doctor`.

One install registers the coordinator, a promotion-capable wrapper around Pi's stock `bash` tool, and the bundled [`@davecodes/pi-subagents`](https://www.npmjs.com/package/@davecodes/pi-subagents) fork (full pi-subagents with top-level foreground-run promotion — remove any standalone `npm:pi-subagents` settings entry to avoid double registration).

Configuration (`~/.pi/agent/background-work.json`), guarantees, group isolation for orchestrators, and the adapter SDK for third-party tool owners are documented in the [repository README](https://github.com/Davidcreador/pi-background-work).
