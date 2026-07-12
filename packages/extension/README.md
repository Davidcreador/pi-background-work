# pi-background-work

Promote already-running foreground work in Pi into session-bound background jobs.

```bash
pi install npm:pi-background-work
```

Type `/background` while a shell command or subagent run executes: the original execution keeps running exactly once, Pi gets its turn back, and the completion is delivered when the agent is idle. A live footer indicator (`↳ ⠼ 2 background · 3m12s · ✓ 1 done`) tracks running jobs and undelivered results.

Commands: `/background`, `/background-jobs` (inspect/cancel/retry), `/background-doctor`.

One install registers the coordinator, a promotion-capable wrapper around Pi's stock `bash` tool, and the bundled [`@davecodes/pi-subagents`](https://www.npmjs.com/package/@davecodes/pi-subagents) fork (full pi-subagents with top-level foreground-run promotion — remove any standalone `npm:pi-subagents` settings entry to avoid double registration).

Configuration (`~/.pi/agent/background-work.json`), guarantees, group isolation for orchestrators, and the adapter SDK for third-party tool owners are documented in the [repository README](https://github.com/Davidcreador/pi-background-work).
