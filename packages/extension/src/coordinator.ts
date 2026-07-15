import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import {
  BACKGROUND_WORK_PROTOCOL_VERSION,
  BACKGROUND_WORK_REGISTER_EVENT,
  BACKGROUND_WORK_STATE_EVENT,
  BACKGROUND_WORK_UNREGISTER_EVENT,
  commandRisk,
  resolveGroupIdentity,
  sessionIdFrom,
  type BackgroundJobSnapshot,
  type BackgroundWorkStateEvent,
  type BackgroundWorkUnregisterEvent,
  type DetachableExecution,
} from "@davecodes/pi-background-work-sdk";
import { boundedString, CompletionDelivery } from "./completion-delivery.ts";
import { detectShortcutConflict, loadBackgroundWorkConfig } from "./config.ts";
import { openBackgroundWorkConfig } from "./config-ui.ts";
import { BackgroundJobManager, createBackgroundWorkStore, type BackgroundWorkStore } from "./job-manager.ts";
import { openJobPalette, type JobPaletteItem } from "./job-palette.ts";
import { boundedJobOutput, formatJobLabel, sortJobsForDisplay } from "./job-presentation.ts";

const GLOBAL_KEY = Symbol.for("pi-background-work.coordinator.v1");
const MUTATION_WARNING_TTL_MS = 30_000;
const INSPECTION_MAX_BYTES = 8 * 1024;
const INSPECTION_MAX_LINES = 120;

interface GlobalCoordinator {
  store: BackgroundWorkStore;
  disposers: Array<() => void>;
  delivery?: CompletionDelivery;
  warningTimes: Map<string, number>;
  lastDeliveryError?: string;
  supervisorPending: Set<string>;
  readyAdapters: Set<string>;
  userInputSequence: number;
  promotionInputSequences: Map<string, number>;
  /** Footer indicator refresh timer; live only while jobs run or completions await delivery. */
  statusTimer?: NodeJS.Timeout;
}

function globalCoordinator(): GlobalCoordinator {
  const root = globalThis as typeof globalThis & { [GLOBAL_KEY]?: GlobalCoordinator };
  root[GLOBAL_KEY] ??= {
    store: createBackgroundWorkStore(),
    disposers: [],
    warningTimes: new Map(),
    supervisorPending: new Set(),
    readyAdapters: new Set(),
    userInputSequence: 0,
    promotionInputSequences: new Map(),
  };
  return root[GLOBAL_KEY];
}

const STATUS_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Compact wall-clock for the footer: 42s, 3m12s, 1h04m. */
function formatElapsedShort(startedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function isDetachableExecution(value: unknown): value is DetachableExecution {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<DetachableExecution>;
  return candidate.protocolVersion === BACKGROUND_WORK_PROTOCOL_VERSION
    && typeof candidate.jobId === "string"
    && typeof candidate.adapterInstanceId === "string"
    && typeof candidate.sessionId === "string"
    && typeof candidate.toolCallId === "string"
    && typeof candidate.promote === "function"
    && typeof candidate.cancel === "function"
    && typeof candidate.inspect === "function"
    && candidate.completion instanceof Promise;
}

export default function backgroundWorkCoordinator(pi: ExtensionAPI, preloaded?: ReturnType<typeof loadBackgroundWorkConfig>): void {
  const shared = globalCoordinator();
  shared.supervisorPending = shared.supervisorPending instanceof Set ? shared.supervisorPending : new Set();
  shared.readyAdapters ??= new Set();
  shared.userInputSequence ??= 0;
  shared.promotionInputSequences ??= new Map();
  for (const dispose of shared.disposers.splice(0)) {
    try { dispose(); } catch { /* stale reload cleanup is best effort */ }
  }
  // The ticker closure belongs to the previous extension generation; the new
  // generation restarts it from its own updateStatusIndicator when needed.
  if (shared.statusTimer) { clearInterval(shared.statusTimer); shared.statusTimer = undefined; }
  shared.delivery?.dispose();
  shared.delivery = undefined;
  shared.store.notify = undefined;

  const loaded = preloaded ?? loadBackgroundWorkConfig();
  const config = loaded.config;
  const metadata = resolveGroupIdentity();
  const promotionAction = config.shortcut && !detectShortcutConflict(config.shortcut) ? config.shortcut : "/background";
  let activeContext: ExtensionContext | undefined;
  let agentBusy = false;
  let userUiBusy = false;
  let spinnerFrame = 0;
  /** Set on non-reload shutdown so late cancellation transitions cannot restart the ticker. */
  let shuttingDown = false;

  const stopStatusTicker = () => {
    if (shared.statusTimer) { clearInterval(shared.statusTimer); shared.statusTimer = undefined; }
  };

  /**
   * Live footer indicator. Three signals share one status entry:
   *   - foreground work that can be promoted: kind/count + the promotion action
   *   - background jobs: animated spinner + count + oldest-job elapsed time
   *   - finished jobs awaiting delivery/acknowledgement: check mark + count
   * The 1s ticker runs only while elapsed background work needs refreshing.
   */
  const updateStatusIndicator = () => {
    if (!config.statusIndicator) {
      stopStatusTicker();
      if (activeContext?.hasUI) activeContext.ui.setStatus("background-work", undefined);
      return;
    }
    const detachable = manager.detachableSnapshots();
    const active = manager.activeSnapshots();
    const undelivered = shared.store.pendingDeliveries.length + shared.store.queued.size;
    if (!detachable.length && !active.length && !undelivered) {
      stopStatusTicker();
      if (activeContext?.hasUI) activeContext.ui.setStatus("background-work", undefined);
      return;
    }
    if (activeContext?.hasUI) {
      const parts: string[] = [];
      if (detachable.length) {
        const subject = detachable.length === 1 ? `${detachable[0]!.kind} running` : `${detachable.length} jobs running`;
        parts.push(`${subject} · ${promotionAction} available`);
      }
      if (active.length) {
        spinnerFrame = (spinnerFrame + 1) % STATUS_SPINNER.length;
        const oldest = Math.min(...active.map((job) => job.startedAt));
        parts.push(`${STATUS_SPINNER[spinnerFrame]} ${active.length} background · ${formatElapsedShort(oldest)}`);
      }
      if (undelivered) parts.push(`✓ ${undelivered} done`);
      activeContext.ui.setStatus("background-work", `↳ ${parts.join(" · ")}`);
    }
    if (active.length && !shared.statusTimer && !shuttingDown) {
      shared.statusTimer = setInterval(updateStatusIndicator, 1_000);
      shared.statusTimer.unref?.();
    } else if (!active.length) {
      stopStatusTicker();
    }
  };

  const publishState = () => {
    const active = manager.activeSnapshots();
    const event: BackgroundWorkStateEvent = {
      protocolVersion: BACKGROUND_WORK_PROTOCOL_VERSION,
      sessionId: shared.store.sessionId,
      groupId: shared.store.groupId,
      role: shared.store.role,
      sequence: ++shared.store.stateSequence,
      activeCount: active.length,
      riskyCount: active.filter((job) => job.mutationRisk !== "read-only").length,
      state: active.length ? "background-active" : "idle",
    };
    pi.events.emit(BACKGROUND_WORK_STATE_EVENT, event);
    updateStatusIndicator();
  };

  const manager = new BackgroundJobManager(shared.store, {
    onTransition(entry) {
      // Persist only promoted-job transitions; ordinary foreground calls stay out of session history.
      pi.appendEntry("background-work-transition", entry);
    },
    onStateChange: publishState,
  });

  const createDelivery = () => {
    shared.delivery?.dispose();
    shared.delivery = new CompletionDelivery(pi, shared.store, {
      debounceMs: config.completionDebounceMs,
      maxOutputBytes: config.maxOutputBytes,
      maxOutputLines: config.maxOutputLines,
      completionBehavior: config.completionBehavior,
      shouldResume: (jobIds) => jobIds.some((jobId) => shared.promotionInputSequences.get(jobId) === shared.userInputSequence),
      role: shared.store.role,
      groupId: shared.store.groupId,
      onQueued: (jobIds) => manager.markQueued(jobIds),
      onError: (error) => { shared.lastDeliveryError = error.message; },
    });
    // Completion is enqueued only at an idle seam. User steering and supervisor/intercom work already queued for the active turn therefore win.
    shared.store.notify = () => { if (!agentBusy && !userUiBusy && shared.supervisorPending.size === 0) shared.delivery?.schedule(); };
    if (!agentBusy && !userUiBusy && shared.supervisorPending.size === 0 && shared.store.pendingDeliveries.length) shared.delivery.schedule();
  };

  shared.disposers.push(
    pi.events.on(BACKGROUND_WORK_REGISTER_EVENT, (payload) => {
      try {
        if (!config.enabled || !isDetachableExecution(payload)) return;
        manager.register(payload);
      } catch (error) {
        // A foreign adapter event must never escape the shared event bus and
        // break the foreground tool whose fallback remains authoritative.
        try { shared.lastDeliveryError = error instanceof Error ? error.message : String(error); }
        catch { shared.lastDeliveryError = "unprintable adapter registration error"; }
      }
    }),
    pi.events.on(BACKGROUND_WORK_UNREGISTER_EVENT, (payload) => {
      const event = payload as Partial<BackgroundWorkUnregisterEvent>;
      if (event.protocolVersion !== BACKGROUND_WORK_PROTOCOL_VERSION || !event.jobId || !event.adapterInstanceId) return;
      manager.unregister(event.jobId, event.adapterInstanceId);
    }),
    pi.events.on("background-work:v1:adapter-ready", (payload) => {
      const event = payload as { protocolVersion?: unknown; toolName?: unknown };
      if (event.protocolVersion === 1 && typeof event.toolName === "string") shared.readyAdapters.add(event.toolName);
    }),
    pi.events.on("background-work:v1:supervisor-state", (payload) => {
      const event = payload as { pending?: unknown; requestId?: unknown; sessionId?: unknown };
      if (typeof event.requestId !== "string" || !event.requestId || event.sessionId !== shared.store.sessionId) return;
      if (event.pending === true) shared.supervisorPending.add(event.requestId);
      if (event.pending === false) shared.supervisorPending.delete(event.requestId);
      if (!agentBusy && !userUiBusy && shared.supervisorPending.size === 0 && shared.store.pendingDeliveries.length) shared.delivery?.schedule();
    }),
  );

  /**
   * Hand control back to the user after promotion. The promoted placeholder
   * result only asks the model to yield — models tend to babysit the job with
   * wait/poll loops instead. "interrupt" ends the streaming turn like ESC
   * (promoted jobs survive: cancellation ownership already moved to the
   * coordinator); "steer" queues an explicit yield instruction into the turn.
   */
  const yieldAfterPromotion = async (ctx: ExtensionContext, jobIds: string[]) => {
    if (config.promotionYield === "off" || ctx.isIdle?.() !== false) return;
    if (config.promotionYield === "steer") {
      pi.sendMessage({
        customType: "background-work-yield",
        content: `The user backgrounded ${jobIds.join(", ")}. Results will be delivered automatically when the jobs finish — stop waiting or polling for them and end your turn now.`,
        display: false,
        details: { jobIds },
      }, { deliverAs: "steer" });
      return;
    }
    // Let the promoted placeholder tool results settle into the turn first.
    await new Promise((resolve) => setImmediate(resolve));
    if (ctx.isIdle?.() === false) ctx.abort();
  };

  const recordPromotions = (jobs: BackgroundJobSnapshot[]) => {
    for (const job of jobs) shared.promotionInputSequences.set(job.jobId, shared.userInputSequence);
  };

  const paletteItems = (): JobPaletteItem[] => sortJobsForDisplay(manager.allSnapshots()).map((job) => ({
    job,
    canCancel: job.state === "background-running",
    ...(shared.store.pendingDeliveries.some((item) => item.jobId === job.jobId)
      ? { retry: "pending" as const }
      : shared.store.queued.has(job.jobId) ? { retry: "queued" as const } : {}),
  }));

  const inspectJob = (ctx: ExtensionContext, job: BackgroundJobSnapshot) => {
    const error = boundedString(job.error, 512);
    const artifactPath = boundedString(job.artifactPath, 512);
    const output = boundedJobOutput(
      job.latestOutput ?? "",
      Math.min(config.maxOutputBytes, INSPECTION_MAX_BYTES),
      Math.min(config.maxOutputLines, INSPECTION_MAX_LINES),
    );
    ctx.ui.notify([
      formatJobLabel(job),
      `Mutation risk: ${job.mutationRisk}`,
      error ? `Error: ${error}` : "",
      output ? `Output:\n${output}` : "Output: (none)",
      artifactPath ? `Full output: ${artifactPath}` : "",
    ].filter(Boolean).join("\n"), job.state === "failed" || job.state === "timed-out" ? "error" : "info");
  };

  const cancelJob = async (ctx: ExtensionContext, job: BackgroundJobSnapshot) => {
    const label = boundedString(job.label, 96) ?? job.jobId;
    const confirmed = job.mutationRisk === "read-only" || await ctx.ui.confirm("Cancel background job?", `${label} (${job.jobId})`);
    if (!confirmed) return;
    ctx.ui.notify(`Cancelling ${label}…`, "info");
    try {
      const cancelled = await manager.cancel(job.jobId);
      const settled = manager.allSnapshots().find((snapshot) => snapshot.jobId === job.jobId);
      if (!cancelled) ctx.ui.notify(`${label} is no longer running.`, "info");
      else if (settled?.state === "cancelled") ctx.ui.notify(`Cancelled ${label}.`, "info");
      else ctx.ui.notify(`${label} finished as ${settled?.state ?? "unknown"} while cancellation was requested.`, settled?.state === "succeeded" ? "info" : "warning");
    } catch (error) {
      ctx.ui.notify(`Could not cancel ${label}: ${boundedString(error instanceof Error ? error.message : error, 256) ?? "unknown error"}`, "error");
    }
  };

  const retryDelivery = async (ctx: ExtensionContext, jobId: string, queued: boolean) => {
    if (queued) {
      const confirmed = await ctx.ui.confirm("Retry already-enqueued completion?", "Pi has not acknowledged context consumption. Retrying is explicit and may duplicate a message that was queued internally.");
      if (!confirmed) return;
      if (!manager.retryQueued(jobId)) {
        ctx.ui.notify("That completion is no longer awaiting acknowledgement.", "info");
        return;
      }
    }
    if (agentBusy || shared.supervisorPending.size > 0) ctx.ui.notify("Completion retry queued until user/supervisor work ends.", "info");
    else {
      if (!userUiBusy) shared.delivery?.schedule();
      ctx.ui.notify("Completion delivery retry requested.", "info");
    }
  };

  const runUserUi = async (run: () => Promise<void>) => {
    userUiBusy = true;
    shared.delivery?.pause();
    try {
      await run();
    } finally {
      userUiBusy = false;
      if (!agentBusy && shared.supervisorPending.size === 0 && shared.store.pendingDeliveries.length) shared.delivery?.schedule();
    }
  };

  pi.registerCommand("background", {
    description: "Promote all active detachable shell/subagent work to the background",
    handler: async (_args, ctx) => {
      activeContext = ctx;
      if (!config.enabled) {
        ctx.ui.notify(`Background work is disabled in ${loaded.path}. Run /background-config to enable it.`, "warning");
        return;
      }
      const promoted = manager.promoteAll();
      recordPromotions(promoted);
      if (!promoted.length) {
        ctx.ui.notify("No active detachable work to background.", "info");
        return;
      }
      ctx.ui.notify(`Backgrounded ${promoted.length} job${promoted.length === 1 ? "" : "s"}: ${promoted.map((job) => job.jobId).join(", ")}`, "info");
      await yieldAfterPromotion(ctx, promoted.map((job) => job.jobId));
    },
  });

  pi.registerCommand("background-config", {
    description: "Configure background work and reload Pi",
    handler: async (_args, ctx) => {
      activeContext = ctx;
      await runUserUi(() => openBackgroundWorkConfig(ctx, loaded));
    },
  });

  pi.registerCommand("background-jobs", {
    description: "Inspect or cancel promoted background jobs",
    handler: async (_args, ctx) => {
      activeContext = ctx;
      if (!config.enabled) {
        ctx.ui.notify(`Background work is disabled in ${loaded.path}. Run /background-config to enable it.`, "warning");
        return;
      }
      await runUserUi(async () => {
        const jobs = sortJobsForDisplay(manager.allSnapshots());
        if (!jobs.length) {
          ctx.ui.notify("No background-work jobs in this session.", "info");
          return;
        }
        if (ctx.mode === "tui") {
          while (true) {
            const result = await openJobPalette(ctx, paletteItems, {
              maxOutputBytes: Math.min(config.maxOutputBytes, INSPECTION_MAX_BYTES),
              maxOutputLines: Math.min(config.maxOutputLines, INSPECTION_MAX_LINES),
            });
            if (!result) return;
            const current = manager.allSnapshots().find((snapshot) => snapshot.jobId === result.jobId);
            if (!current) {
              ctx.ui.notify("That background job is no longer available.", "info");
              continue;
            }
            if (result.action === "cancel") await cancelJob(ctx, current);
            else {
              await retryDelivery(ctx, current.jobId, result.queued);
              return;
            }
          }
        }

        const labels = jobs.map((job) => formatJobLabel(job));
        const selected = await ctx.ui.select("Background jobs", labels);
        const index = selected ? labels.indexOf(selected) : -1;
        if (index < 0) return;
        const job = jobs[index]!;
        const pendingDelivery = shared.store.pendingDeliveries.some((item) => item.jobId === job.jobId);
        const queuedDelivery = shared.store.queued.has(job.jobId);
        const actions = job.state === "background-running"
          ? ["Inspect", "Cancel"]
          : pendingDelivery ? ["Inspect", "Retry completion delivery"]
            : queuedDelivery ? ["Inspect", "Retry queued completion (may duplicate)"] : ["Inspect"];
        const action = await ctx.ui.select(job.jobId, actions);
        if (action === "Inspect") inspectJob(ctx, job);
        else if (action === "Cancel") await cancelJob(ctx, job);
        else if (action === "Retry completion delivery") await retryDelivery(ctx, job.jobId, false);
        else if (action === "Retry queued completion (may duplicate)") await retryDelivery(ctx, job.jobId, true);
      });
    },
  });

  pi.registerCommand("background-doctor", {
    description: "Diagnose background-work configuration, adapters, and active jobs",
    handler: async (_args, ctx) => {
      activeContext = ctx;
      const conflict = detectShortcutConflict(config.shortcut);
      ctx.ui.notify([
        `Enabled: ${config.enabled}`,
        `Config: ${loaded.path}${loaded.error ? ` (${loaded.error})` : ""}`,
        `Shortcut: ${config.shortcut ?? "none"}${conflict ? ` (conflicts with ${conflict})` : ""}`,
        `Promotion yield: ${config.promotionYield}`,
        `Completion behavior: ${config.completionBehavior}`,
        `Session: ${shared.store.sessionId || "not started"}`,
        `Role: ${shared.store.role ?? "ordinary"}`,
        `Group: ${shared.store.groupId ?? "none"}`,
        `Generation: ${shared.store.generation}`,
        `Runtime-ready adapters: ${shared.readyAdapters.size ? [...shared.readyAdapters].sort().join(", ") : "none"}`,
        `Active jobs: ${manager.activeSnapshots().length}`,
        `Pending deliveries: ${shared.store.pendingDeliveries.length}`,
        `Queued awaiting context acknowledgement: ${shared.store.queued.size}`,
        `Blocking supervisor requests: ${shared.supervisorPending.size}`,
        `Last delivery error: ${shared.lastDeliveryError ?? "none"}`,
        loaded.error || conflict ? "Repair: /background-config" : "Configure: /background-config",
      ].join("\n"), loaded.error || conflict ? "warning" : "info");
    },
  });

  if (config.enabled && config.shortcut) {
    const conflict = detectShortcutConflict(config.shortcut);
    if (!conflict) {
      pi.registerShortcut(config.shortcut as KeyId, {
        description: "Move active shell/subagent work to background",
        handler: async (ctx) => {
          activeContext = ctx;
          const promoted = manager.promoteAll();
          recordPromotions(promoted);
          ctx.ui.notify(promoted.length ? `Backgrounded ${promoted.length} job${promoted.length === 1 ? "" : "s"}.` : "No active detachable work.", "info");
          if (promoted.length) await yieldAfterPromotion(ctx, promoted.map((job) => job.jobId));
        },
      });
    }
  }

  pi.on("session_start", (event, ctx) => {
    activeContext = ctx;
    // Blocking request events are generation/session scoped; stale unmatched starts must never survive reload.
    shared.supervisorPending.clear();
    const id = sessionIdFrom(ctx);
    const preserveJobs = event.reason === "reload" && shared.store.sessionId === id;
    if (!preserveJobs) {
      shared.userInputSequence = 0;
      shared.promotionInputSequences.clear();
    }
    manager.setSession({
      sessionId: id,
      groupId: metadata.groupId,
      role: metadata.role,
      preserveJobs,
    });
    createDelivery();
    if (loaded.error && ctx.hasUI) ctx.ui.notify(`Background work disabled: ${loaded.error}. Run /background-config to repair it.`, "warning");
    const conflict = detectShortcutConflict(config.shortcut);
    if (conflict && ctx.hasUI) ctx.ui.notify(`Background shortcut '${config.shortcut}' conflicts with ${conflict}; shortcut not registered. Run /background-config to choose another.`, "warning");
  });

  const confirmSessionReplacement = async (ctx: ExtensionContext) => {
    const active = manager.activeSnapshots();
    if (!active.length) return undefined;
    if (!ctx.hasUI) return { cancel: true };
    const confirmed = await ctx.ui.confirm("Cancel background work?", `${active.length} background job${active.length === 1 ? " is" : "s are"} active. Session replacement must cancel them.`);
    if (!confirmed) return { cancel: true };
    const result = await manager.cancelAll();
    if (result.failed.length) {
      ctx.ui.notify(`Could not cancel: ${result.failed.map((item) => item.jobId).join(", ")}`, "error");
      return { cancel: true };
    }
    return undefined;
  };

  pi.on("session_before_switch", async (_event, ctx) => confirmSessionReplacement(ctx));
  pi.on("session_before_fork", async (_event, ctx) => confirmSessionReplacement(ctx));

  pi.on("input", (event) => {
    if (event.source !== "extension") shared.userInputSequence += 1;
  });

  pi.on("agent_start", () => {
    agentBusy = true;
    shared.delivery?.pause();
  });

  pi.on("agent_end", () => {
    agentBusy = false;
    if (!userUiBusy && shared.supervisorPending.size === 0 && shared.store.pendingDeliveries.length) shared.delivery?.schedule();
  });

  pi.on("context", (event) => {
    for (const message of event.messages) {
      if (message.role !== "custom" || message.customType !== "background-work-completion") continue;
      if (typeof message.details !== "object" || message.details === null) continue;
      const details = message.details as { version?: unknown; groupId?: unknown; completions?: unknown };
      // The sent details.groupId was normalized/truncated by the delivery
      // formatter; compare bounded-to-bounded or a >128-byte group id would
      // never acknowledge and jobs would sit "queued" forever.
      if (details.version !== 1 || details.groupId !== boundedString(shared.store.groupId, 128) || !Array.isArray(details.completions)) continue;
      const jobIds = details.completions.flatMap((item) => typeof item === "object" && item !== null && "jobId" in item && typeof item.jobId === "string" ? [item.jobId] : []);
      manager.markDelivered(jobIds);
      for (const jobId of jobIds) if (shared.store.delivered.has(jobId)) shared.promotionInputSequences.delete(jobId);
    }
  });

  pi.on("session_shutdown", async (event) => {
    shared.supervisorPending.clear();
    shared.delivery?.dispose();
    shared.delivery = undefined;
    shared.store.notify = undefined;
    if (event.reason !== "reload") {
      // Guard before cancelAll: its state transitions re-enter
      // updateStatusIndicator, which must not restart the ticker mid-shutdown.
      shuttingDown = true;
      const result = await manager.cancelAll(true);
      if (result.failed.length) process.stderr.write(`[background-work] shutdown cancellation failed: ${result.failed.map((item) => `${item.jobId}: ${item.error}`).join("; ")}\n`);
    }
    stopStatusTicker();
  });

  pi.on("tool_call", (event, ctx) => {
    activeContext = ctx;
    if (!config.mutationWarnings || !ctx.hasUI) return;
    if (event.toolName !== "edit" && event.toolName !== "write" && event.toolName !== "bash") return;
    if (event.toolName === "bash") {
      const command = typeof event.input?.command === "string" ? event.input.command : "";
      if (commandRisk(command) === "read-only") return;
    }
    const risky = manager.riskyActiveSnapshots();
    if (!risky.length) return;
    const signature = `${event.toolName}:${risky.map((job) => job.jobId).sort().join(",")}`;
    const previous = shared.warningTimes.get(signature) ?? 0;
    if (Date.now() - previous < MUTATION_WARNING_TTL_MS) return;
    shared.warningTimes.set(signature, Date.now());
    ctx.ui.notify(`Background work may still mutate this checkout: ${risky.map((job) => job.jobId).join(", ")}. Inspect with /background-jobs.`, "warning");
  });
}
