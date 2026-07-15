import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import backgroundWorkExtension from "../src/coordinator.ts";

// Harness sessions export role/mission env vars; that group identity must not
// leak into these fixtures or every ordinary registration is rejected.
delete process.env.PI_BACKGROUND_WORK_ROLE;
delete process.env.PI_BACKGROUND_WORK_GROUP_ID;
delete process.env.AGENT_HARNESS_ROLE;
delete process.env.AGENT_HARNESS_MISSION_ID;

class EventBus {
  listeners = new Map<string, Set<(value: unknown) => void>>();
  on(name: string, handler: (value: unknown) => void) {
    const set = this.listeners.get(name) ?? new Set(); set.add(handler); this.listeners.set(name, set);
    return () => set.delete(handler);
  }
  emit(name: string, value: unknown) { for (const handler of this.listeners.get(name) ?? []) handler(value); }
}

test("fake Pi host registers commands, owns one reload listener generation, and reports runtime adapter readiness", async () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bg-host-")), "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true, shortcut: null }));
  const previous = process.env.PI_BACKGROUND_WORK_CONFIG; process.env.PI_BACKGROUND_WORK_CONFIG = configPath;
  try {
    const bus = new EventBus(); const commands = new Map<string, any>(); const lifecycle = new Map<string, any[]>(); const notices: string[] = [];
    const pi: any = {
      events: bus,
      registerCommand(name: string, definition: unknown) { commands.set(name, definition); }, registerShortcut() {}, appendEntry() {}, sendMessage() {},
      on(name: string, handler: unknown) { const list = lifecycle.get(name) ?? []; list.push(handler); lifecycle.set(name, list); },
    };
    backgroundWorkExtension(pi);
    assert.deepEqual([...commands.keys()].sort(), ["background", "background-config", "background-doctor", "background-jobs"]);
    const ctx: any = { sessionManager: { getSessionFile: () => "/tmp/host-session.jsonl" }, hasUI: true, ui: { setStatus() {}, notify(message: string) { notices.push(message); }, select: async () => undefined, confirm: async () => true } };
    lifecycle.get("session_start")?.at(-1)({ reason: "startup" }, ctx);
    const hostilePayload = Object.defineProperty({}, "protocolVersion", { get() { throw new Error("hostile registration getter"); } });
    assert.doesNotThrow(() => bus.emit("background-work:v1:register", hostilePayload));
    bus.emit("background-work:v1:adapter-ready", { protocolVersion: 1, toolName: "bash" });
    await commands.get("background-doctor").handler("", ctx);
    assert.match(notices.at(-1) ?? "", /Runtime-ready adapters: bash/);
    bus.emit("background-work:v1:supervisor-state", { pending: true, requestId: "old-generation" });
    backgroundWorkExtension(pi);
    lifecycle.get("session_start")?.at(-1)({ reason: "reload" }, ctx);
    await commands.get("background-doctor").handler("", ctx);
    assert.match(notices.at(-1) ?? "", /Blocking supervisor requests: 0/);
    assert.equal(bus.listeners.get("background-work:v1:register")?.size, 1);
    assert.equal(bus.listeners.get("background-work:v1:supervisor-state")?.size, 1);
  } finally { if (previous === undefined) delete process.env.PI_BACKGROUND_WORK_CONFIG; else process.env.PI_BACKGROUND_WORK_CONFIG = previous; }
});

test("blocking supervisor state defers completion until release and context acknowledges it", async () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bg-priority-")), "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true, completionDebounceMs: 0 }));
  const previous = process.env.PI_BACKGROUND_WORK_CONFIG; process.env.PI_BACKGROUND_WORK_CONFIG = configPath;
  try {
    const bus = new EventBus(); const lifecycle = new Map<string, any[]>(); const commands = new Map<string, any>(); const sent: any[] = []; let resolve!: (value: any) => void;
    const completion = new Promise<any>((done) => { resolve = done; });
    const pi: any = { events: bus, registerCommand(name:string,definition:unknown){commands.set(name,definition)}, registerShortcut() {}, appendEntry() {}, sendMessage(message: unknown) { sent.push(message); }, on(name: string, handler: unknown) { const list=lifecycle.get(name)??[];list.push(handler);lifecycle.set(name,list); } };
    backgroundWorkExtension(pi); const ctx: any = { sessionManager: { getSessionFile: () => "/tmp/priority.jsonl" }, hasUI: true, ui: { setStatus() {}, notify() {} } };
    lifecycle.get("session_start")?.at(-1)({ reason: "startup" }, ctx);
    const crypto = await import("node:crypto"); const sessionId=crypto.createHash("sha1").update("/tmp/priority.jsonl").digest("hex").slice(0,16);
    let promoted=false; const execution:any={protocolVersion:1,jobId:"priority-job",adapterInstanceId:"a",sessionId,toolCallId:"t",toolName:"bash",kind:"shell",label:"sleep",startedAt:1,mutationRisk:"unknown",promote(){promoted=true;return{promoted:true,jobId:this.jobId}},cancel(){},inspect(){return{jobId:this.jobId,sessionId,toolCallId:"t",toolName:"bash",kind:"shell",label:"sleep",startedAt:1,state:promoted?"background-running":"foreground-running",mutationRisk:"unknown"}},completion};
    bus.emit("background-work:v1:register",execution); await commands.get("background").handler("",ctx); bus.emit("background-work:v1:supervisor-state",{pending:true,requestId:"ignored-without-session"}); bus.emit("background-work:v1:supervisor-state",{pending:true,requestId:"req-1",sessionId});
    resolve({jobId:"priority-job",status:"succeeded",finishedAt:2,durationMs:1,summary:"done"}); await new Promise((done)=>setImmediate(done)); assert.equal(sent.length,0);
    bus.emit("background-work:v1:supervisor-state",{pending:false,requestId:"req-1",sessionId}); await new Promise((done)=>setTimeout(done,10)); assert.equal(sent.length,1);
    const message=sent[0]; lifecycle.get("context")?.at(-1)({messages:[{role:"custom",...message}]});
  } finally { if(previous===undefined)delete process.env.PI_BACKGROUND_WORK_CONFIG;else process.env.PI_BACKGROUND_WORK_CONFIG=previous; }
});

test("context acknowledgement ignores malformed persisted completion details", () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bg-context-shape-")), "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true }));
  const previous = process.env.PI_BACKGROUND_WORK_CONFIG; process.env.PI_BACKGROUND_WORK_CONFIG = configPath;
  try {
    const bus = new EventBus(); const lifecycle = new Map<string, any[]>();
    const pi: any = { events: bus, registerCommand() {}, registerShortcut() {}, appendEntry() {}, sendMessage() {}, on(name: string, handler: unknown) { const list = lifecycle.get(name) ?? []; list.push(handler); lifecycle.set(name, list); } };
    backgroundWorkExtension(pi);
    const ctx: any = { sessionManager: { getSessionFile: () => "/tmp/context-shape.jsonl" }, hasUI: true, ui: { setStatus() {}, notify() {} } };
    lifecycle.get("session_start")?.at(-1)({ reason: "startup" }, ctx);
    const acknowledge = lifecycle.get("context")?.at(-1);
    for (const completions of [{ malformed: true }, [null]]) {
      assert.doesNotThrow(() => acknowledge({ messages: [{ role: "custom", customType: "background-work-completion", content: "persisted", details: { version: 1, completions } }] }));
    }
  } finally { if (previous === undefined) delete process.env.PI_BACKGROUND_WORK_CONFIG; else process.env.PI_BACKGROUND_WORK_CONFIG = previous; }
});

test("adaptive completion tracks newer user input across reload", async () => {
  const run = async (newerInput: boolean, reload = false, prematureAck = false) => {
    const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bg-adaptive-")), "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ enabled: true, completionDebounceMs: 0, completionBehavior: "adaptive" }));
    const previous = process.env.PI_BACKGROUND_WORK_CONFIG; process.env.PI_BACKGROUND_WORK_CONFIG = configPath;
    try {
      const bus = new EventBus(); const lifecycle = new Map<string, any[]>(); const commands = new Map<string, any>(); const sent: any[] = []; let finish!: (value: any) => void;
      const completion = new Promise<any>((resolve) => { finish = resolve; });
      const pi: any = { events: bus, registerCommand(name: string, definition: unknown) { commands.set(name, definition); }, registerShortcut() {}, appendEntry() {}, sendMessage(message: unknown, options: unknown) { sent.push([message, options]); }, on(name: string, handler: unknown) { const list = lifecycle.get(name) ?? []; list.push(handler); lifecycle.set(name, list); } };
      backgroundWorkExtension(pi);
      const sessionFile = `/tmp/adaptive-${newerInput}-${reload}-${prematureAck}.jsonl`; const ctx: any = { sessionManager: { getSessionFile: () => sessionFile }, hasUI: true, ui: { setStatus() {}, notify() {} } };
      lifecycle.get("session_start")?.at(-1)({ reason: "startup" }, ctx);
      const crypto = await import("node:crypto"); const sessionId = crypto.createHash("sha1").update(sessionFile).digest("hex").slice(0, 16); let promoted = false;
      const execution: any = { protocolVersion: 1, jobId: `adaptive-${newerInput}`, adapterInstanceId: "a", sessionId, toolCallId: "t", toolName: "bash", kind: "shell", label: "sleep", startedAt: 1, mutationRisk: "read-only", promote() { promoted = true; return { promoted: true, jobId: this.jobId }; }, cancel() {}, inspect() { return { jobId: this.jobId, sessionId, toolCallId: "t", toolName: "bash", kind: "shell", label: "sleep", startedAt: 1, state: promoted ? "background-running" : "foreground-running", mutationRisk: "read-only" }; }, completion };
      bus.emit("background-work:v1:register", execution);
      await commands.get("background").handler("", ctx);
      if (prematureAck) lifecycle.get("context")?.at(-1)({ messages: [{ role: "custom", customType: "background-work-completion", content: "stale", details: { version: 1, completions: [{ jobId: execution.jobId }] } }] });
      if (newerInput) lifecycle.get("input")?.at(-1)({ type: "input", text: "new request", source: "interactive" }, ctx);
      if (reload) {
        backgroundWorkExtension(pi);
        lifecycle.get("session_start")?.at(-1)({ reason: "reload" }, ctx);
      }
      finish({ jobId: execution.jobId, status: "succeeded", finishedAt: 2, durationMs: 1, summary: "done" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { triggerTurn: sent[0]?.[1]?.triggerTurn, autoResume: sent[0]?.[0]?.details?.autoResume };
    } finally { if (previous === undefined) delete process.env.PI_BACKGROUND_WORK_CONFIG; else process.env.PI_BACKGROUND_WORK_CONFIG = previous; }
  };
  assert.deepEqual(await run(false), { triggerTurn: true, autoResume: true });
  assert.deepEqual(await run(true), { triggerTurn: false, autoResume: false });
  assert.deepEqual(await run(false, true), { triggerTurn: true, autoResume: true });
  assert.deepEqual(await run(true, true), { triggerTurn: false, autoResume: false });
  assert.deepEqual(await run(false, false, true), { triggerTurn: true, autoResume: true });
});

test("disabling the status indicator clears stale footer state", () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bg-status-off-")), "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true, statusIndicator: false }));
  const previous = process.env.PI_BACKGROUND_WORK_CONFIG; process.env.PI_BACKGROUND_WORK_CONFIG = configPath;
  try {
    const bus = new EventBus(); const lifecycle = new Map<string, any[]>(); const statuses: Array<string | undefined> = ["stale"];
    const pi: any = { events: bus, registerCommand() {}, registerShortcut() {}, appendEntry() {}, sendMessage() {}, on(name: string, handler: unknown) { const list = lifecycle.get(name) ?? []; list.push(handler); lifecycle.set(name, list); } };
    backgroundWorkExtension(pi);
    const ctx: any = { sessionManager: { getSessionFile: () => "/tmp/status-off.jsonl" }, hasUI: true, ui: { setStatus(_key: string, value: string | undefined) { statuses.push(value); } } };
    lifecycle.get("session_start")?.at(-1)({ reason: "startup" }, ctx);
    assert.equal(statuses.at(-1), undefined);
  } finally { if (previous === undefined) delete process.env.PI_BACKGROUND_WORK_CONFIG; else process.env.PI_BACKGROUND_WORK_CONFIG = previous; }
});

test("footer indicator animates while jobs run, shows undelivered completions, and clears after acknowledgement", async () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bg-status-")), "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true, completionDebounceMs: 0 }));
  const previous = process.env.PI_BACKGROUND_WORK_CONFIG; process.env.PI_BACKGROUND_WORK_CONFIG = configPath;
  try {
    const bus = new EventBus(); const lifecycle = new Map<string, any[]>(); const commands = new Map<string, any>(); const sent: any[] = []; const statuses: Array<string | undefined> = [];
    const pi: any = { events: bus, registerCommand(name: string, definition: unknown) { commands.set(name, definition); }, registerShortcut() {}, appendEntry() {}, sendMessage(message: unknown) { sent.push(message); }, on(name: string, handler: unknown) { const list = lifecycle.get(name) ?? []; list.push(handler); lifecycle.set(name, list); } };
    backgroundWorkExtension(pi);
    const ctx: any = { sessionManager: { getSessionFile: () => "/tmp/status.jsonl" }, hasUI: true, ui: { setStatus(_key: string, text: string | undefined) { statuses.push(text); }, notify() {} } };
    lifecycle.get("session_start")?.at(-1)({ reason: "startup" }, ctx);
    const crypto = await import("node:crypto"); const sessionId = crypto.createHash("sha1").update("/tmp/status.jsonl").digest("hex").slice(0, 16);
    let resolve!: (value: any) => void; const completion = new Promise<any>((done) => { resolve = done; });
    let promoted = false;
    const execution: any = { protocolVersion: 1, jobId: "status-job", adapterInstanceId: "a", sessionId, toolCallId: "t", toolName: "bash", kind: "shell", label: "sleep", startedAt: Date.now(), mutationRisk: "unknown", promote() { promoted = true; return { promoted: true, jobId: this.jobId }; }, cancel() {}, inspect() { return { jobId: this.jobId, sessionId, toolCallId: "t", toolName: "bash", kind: "shell", label: "sleep", startedAt: 1, state: promoted ? "background-running" : "foreground-running", mutationRisk: "unknown" }; }, completion };
    bus.emit("background-work:v1:register", execution);
    // Foreground: advertise the action exactly when it is useful.
    assert.match(statuses.at(-1) ?? "", /↳ shell running · \/background available/);
    await commands.get("background").handler("", ctx);
    // Background: replace the affordance with spinner + count + elapsed.
    assert.match(statuses.at(-1) ?? "", /↳ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1 background · \d+s/);
    resolve({ jobId: "status-job", status: "succeeded", finishedAt: Date.now(), durationMs: 5, summary: "done" });
    await new Promise((done) => setTimeout(done, 15));
    // Enqueued but unacknowledged: no spinner, undelivered count visible.
    assert.equal(sent.length, 1);
    assert.match(statuses.at(-1) ?? "", /↳ ✓ 1 done/);
    // Context acknowledgement drains the indicator entirely.
    lifecycle.get("context")?.at(-1)({ messages: [{ role: "custom", ...sent[0] }] });
    assert.equal(statuses.at(-1), undefined);
  } finally { if (previous === undefined) delete process.env.PI_BACKGROUND_WORK_CONFIG; else process.env.PI_BACKGROUND_WORK_CONFIG = previous; }
});

test("job picker uses human-first labels and acknowledges cancellation", async () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bg-jobs-")), "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true }));
  const previous = process.env.PI_BACKGROUND_WORK_CONFIG; process.env.PI_BACKGROUND_WORK_CONFIG = configPath;
  try {
    const bus = new EventBus(); const lifecycle = new Map<string, any[]>(); const commands = new Map<string, any>(); const notices: string[] = []; const selections: string[][] = [];
    const pi: any = { events: bus, registerCommand(name: string, definition: unknown) { commands.set(name, definition); }, registerShortcut() {}, appendEntry() {}, sendMessage() {}, on(name: string, handler: unknown) { const list = lifecycle.get(name) ?? []; list.push(handler); lifecycle.set(name, list); } };
    backgroundWorkExtension(pi);
    const ctx: any = { sessionManager: { getSessionFile: () => "/tmp/jobs.jsonl" }, hasUI: true, ui: { setStatus() {}, notify(message: string) { notices.push(message); }, confirm: async () => true, select: async (title: string, options: string[]) => { selections.push(options); return title === "Background jobs" ? options[0] : "Cancel"; } } };
    lifecycle.get("session_start")?.at(-1)({ reason: "startup" }, ctx);
    const crypto = await import("node:crypto"); const sessionId = crypto.createHash("sha1").update("/tmp/jobs.jsonl").digest("hex").slice(0, 16);
    let resolve!: (value: any) => void; const completion = new Promise<any>((done) => { resolve = done; }); let promoted = false;
    const execution: any = { protocolVersion: 1, jobId: "cancel-job", adapterInstanceId: "a", sessionId, toolCallId: "t", toolName: "bash", kind: "shell", label: "sleep 60", startedAt: Date.now(), mutationRisk: "read-only", promote() { promoted = true; return { promoted: true, jobId: this.jobId }; }, cancel() { resolve({ jobId: this.jobId, status: "cancelled", finishedAt: Date.now(), durationMs: 5, summary: "cancelled" }); }, inspect() { return { jobId: this.jobId, sessionId, toolCallId: "t", toolName: "bash", kind: "shell", label: "sleep 60", startedAt: this.startedAt, state: promoted ? "background-running" : "foreground-running", mutationRisk: "read-only" }; }, completion };
    bus.emit("background-work:v1:register", execution);
    await commands.get("background").handler("", ctx);
    await commands.get("background-jobs").handler("", ctx);
    assert.match(selections[0]?.[0] ?? "", /^● sleep 60 · shell running/);
    assert.deepEqual(selections[1], ["Inspect", "Cancel"]);
    assert.ok(notices.some((notice) => notice === "Cancelling sleep 60…"));
    assert.ok(notices.some((notice) => notice === "Cancelled sleep 60."));
  } finally { if (previous === undefined) delete process.env.PI_BACKGROUND_WORK_CONFIG; else process.env.PI_BACKGROUND_WORK_CONFIG = previous; }
});

test("TUI job command opens one live palette instead of nested selectors", async () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bg-palette-")), "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true, completionDebounceMs: 0 }));
  const previous = process.env.PI_BACKGROUND_WORK_CONFIG; process.env.PI_BACKGROUND_WORK_CONFIG = configPath;
  try {
    const bus = new EventBus(); const lifecycle = new Map<string, any[]>(); const commands = new Map<string, any>(); const sent: any[] = []; let rendered = ""; let selectCalls = 0; let sentWhileOpen = -1; let finish!: (value: any) => void;
    const completion = new Promise<any>((resolve) => { finish = resolve; });
    const pi: any = { events: bus, registerCommand(name: string, definition: unknown) { commands.set(name, definition); }, registerShortcut() {}, appendEntry() {}, sendMessage(message: unknown) { sent.push(message); }, on(name: string, handler: unknown) { const list = lifecycle.get(name) ?? []; list.push(handler); lifecycle.set(name, list); } };
    backgroundWorkExtension(pi);
    const keybindings: any = { matches(data: string, action: string) { return action === "tui.select.cancel" && data === "escape"; }, getKeys() { return ["ctrl+o"]; } };
    const theme: any = { fg(_tone: string, value: string) { return value; } };
    const ctx: any = { mode: "tui", sessionManager: { getSessionFile: () => "/tmp/palette.jsonl" }, hasUI: true, ui: { setStatus() {}, notify() {}, confirm: async () => true, select: async () => { selectCalls++; return undefined; }, custom: async (factory: any) => new Promise((resolve) => { const component = factory({ requestRender() {} }, theme, keybindings, resolve); rendered = component.render(100).join("\n"); finish({ jobId: "palette-job", status: "succeeded", finishedAt: Date.now(), durationMs: 5, summary: "done" }); setTimeout(() => { sentWhileOpen = sent.length; component.handleInput("escape"); component.dispose?.(); }, 5); }) } };
    lifecycle.get("session_start")?.at(-1)({ reason: "startup" }, ctx);
    const crypto = await import("node:crypto"); const sessionId = crypto.createHash("sha1").update("/tmp/palette.jsonl").digest("hex").slice(0, 16); let promoted = false;
    const execution: any = { protocolVersion: 1, jobId: "palette-job", adapterInstanceId: "a", sessionId, toolCallId: "t", toolName: "bash", kind: "shell", label: "npm test", startedAt: Date.now(), mutationRisk: "read-only", promote() { promoted = true; return { promoted: true, jobId: this.jobId }; }, cancel() {}, inspect() { return { jobId: this.jobId, sessionId, toolCallId: "t", toolName: "bash", kind: "shell", label: "npm test", startedAt: this.startedAt, state: promoted ? "background-running" : "foreground-running", mutationRisk: "read-only", latestOutput: "running tests" }; }, completion };
    bus.emit("background-work:v1:register", execution);
    await commands.get("background").handler("", ctx);
    await commands.get("background-jobs").handler("", ctx);
    assert.match(rendered, /Background jobs/);
    assert.match(rendered, /npm test/);
    assert.match(rendered, /running tests/);
    assert.equal(selectCalls, 0);
    assert.equal(sentWhileOpen, 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sent.length, 1);
  } finally { if (previous === undefined) delete process.env.PI_BACKGROUND_WORK_CONFIG; else process.env.PI_BACKGROUND_WORK_CONFIG = previous; }
});

test("promotion yields the streaming turn: interrupt aborts, steer nudges, off leaves it alone", async () => {
  const run = async (promotionYield: string) => {
    const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bg-yield-")), "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ enabled: true, promotionYield }));
    const previous = process.env.PI_BACKGROUND_WORK_CONFIG; process.env.PI_BACKGROUND_WORK_CONFIG = configPath;
    try {
      const bus = new EventBus(); const lifecycle = new Map<string, any[]>(); const commands = new Map<string, any>(); const sent: any[] = []; let aborts = 0; let idle = false;
      const pi: any = { events: bus, registerCommand(name: string, definition: unknown) { commands.set(name, definition); }, registerShortcut() {}, appendEntry() {}, sendMessage(message: unknown, options: unknown) { sent.push([message, options]); }, on(name: string, handler: unknown) { const list = lifecycle.get(name) ?? []; list.push(handler); lifecycle.set(name, list); } };
      backgroundWorkExtension(pi);
      const ctx: any = { sessionManager: { getSessionFile: () => "/tmp/yield.jsonl" }, hasUI: true, ui: { setStatus() {}, notify() {} }, isIdle: () => idle, abort() { aborts++; idle = true; } };
      lifecycle.get("session_start")?.at(-1)({ reason: "startup" }, ctx);
      const crypto = await import("node:crypto"); const sessionId = crypto.createHash("sha1").update("/tmp/yield.jsonl").digest("hex").slice(0, 16);
      let promoted = false;
      const execution: any = { protocolVersion: 1, jobId: "yield-job", adapterInstanceId: "a", sessionId, toolCallId: "t", toolName: "bash", kind: "shell", label: "sleep", startedAt: 1, mutationRisk: "unknown", promote() { promoted = true; return { promoted: true, jobId: this.jobId }; }, cancel() {}, inspect() { return { jobId: this.jobId, sessionId, toolCallId: "t", toolName: "bash", kind: "shell", label: "sleep", startedAt: 1, state: promoted ? "background-running" : "foreground-running", mutationRisk: "unknown" }; }, completion: new Promise(() => {}) };
      bus.emit("background-work:v1:register", execution);
      await commands.get("background").handler("", ctx);
      return { aborts, steers: sent.filter(([message, options]) => (message as any).customType === "background-work-yield" && (options as any)?.deliverAs === "steer").length };
    } finally { if (previous === undefined) delete process.env.PI_BACKGROUND_WORK_CONFIG; else process.env.PI_BACKGROUND_WORK_CONFIG = previous; }
  };
  assert.deepEqual(await run("interrupt"), { aborts: 1, steers: 0 });
  assert.deepEqual(await run("steer"), { aborts: 0, steers: 1 });
  assert.deepEqual(await run("off"), { aborts: 0, steers: 0 });
});

test("resources_discover contributes the bundled fork's skills and prompts wherever npm placed it", async () => {
  const { registerSubagentResources } = await import("../src/subagent-resources.ts");
  const handlers = new Map<string, any>();
  const pi: any = { on(name: string, handler: unknown) { handlers.set(name, handler); } };
  registerSubagentResources(pi);
  const result = handlers.get("resources_discover")({ reason: "startup" });
  assert.equal(result.skillPaths.length, 1);
  assert.ok(fs.existsSync(path.join(result.skillPaths[0], "pi-subagents")));
  assert.equal(result.promptPaths.length, 1);
  assert.ok(fs.existsSync(result.promptPaths[0]));
});

test("group ids longer than the delivery bound still acknowledge and drain", async () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bg-longgroup-")), "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true, completionDebounceMs: 0 }));
  const longGroup = "g".repeat(300);
  const previousConfig = process.env.PI_BACKGROUND_WORK_CONFIG; const previousGroup = process.env.PI_BACKGROUND_WORK_GROUP_ID;
  process.env.PI_BACKGROUND_WORK_CONFIG = configPath; process.env.PI_BACKGROUND_WORK_GROUP_ID = longGroup;
  try {
    const bus = new EventBus(); const lifecycle = new Map<string, any[]>(); const commands = new Map<string, any>(); const sent: any[] = []; const notices: string[] = [];
    const pi: any = { events: bus, registerCommand(name: string, definition: unknown) { commands.set(name, definition); }, registerShortcut() {}, appendEntry() {}, sendMessage(message: unknown) { sent.push(message); }, on(name: string, handler: unknown) { const list = lifecycle.get(name) ?? []; list.push(handler); lifecycle.set(name, list); } };
    backgroundWorkExtension(pi);
    const ctx: any = { sessionManager: { getSessionFile: () => "/tmp/long-group.jsonl" }, hasUI: true, ui: { setStatus() {}, notify(message: string) { notices.push(message); } } };
    lifecycle.get("session_start")?.at(-1)({ reason: "startup" }, ctx);
    const crypto = await import("node:crypto"); const sessionId = crypto.createHash("sha1").update("/tmp/long-group.jsonl").digest("hex").slice(0, 16);
    let resolve!: (value: any) => void; const completion = new Promise<any>((done) => { resolve = done; });
    let promoted = false;
    const execution: any = { protocolVersion: 1, jobId: "long-group-job", adapterInstanceId: "a", sessionId, groupId: longGroup, toolCallId: "t", toolName: "bash", kind: "shell", label: "sleep", startedAt: 1, mutationRisk: "unknown", promote() { promoted = true; return { promoted: true, jobId: this.jobId }; }, cancel() {}, inspect() { return { jobId: this.jobId, sessionId, groupId: longGroup, toolCallId: "t", toolName: "bash", kind: "shell", label: "sleep", startedAt: 1, state: promoted ? "background-running" : "foreground-running", mutationRisk: "unknown" }; }, completion };
    bus.emit("background-work:v1:register", execution);
    await commands.get("background").handler("", ctx);
    resolve({ jobId: "long-group-job", status: "succeeded", finishedAt: 2, durationMs: 1, summary: "done" });
    await new Promise((done) => setTimeout(done, 15));
    assert.equal(sent.length, 1);
    // Regression: the sent details.groupId is truncated to 128 bytes; the ack
    // comparison must bound both sides or this job stays queued forever.
    lifecycle.get("context")?.at(-1)({ messages: [{ role: "custom", ...sent[0] }] });
    await commands.get("background-doctor").handler("", ctx);
    assert.match(notices.at(-1) ?? "", /Queued awaiting context acknowledgement: 0/);
  } finally {
    if (previousConfig === undefined) delete process.env.PI_BACKGROUND_WORK_CONFIG; else process.env.PI_BACKGROUND_WORK_CONFIG = previousConfig;
    if (previousGroup === undefined) delete process.env.PI_BACKGROUND_WORK_GROUP_ID; else process.env.PI_BACKGROUND_WORK_GROUP_ID = previousGroup;
  }
});
