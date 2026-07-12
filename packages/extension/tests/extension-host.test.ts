import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import backgroundWorkExtension from "../src/coordinator.ts";

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
    assert.deepEqual([...commands.keys()].sort(), ["background", "background-doctor", "background-jobs"]);
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
    await commands.get("background").handler("", ctx);
    // Running: spinner + count + elapsed.
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
