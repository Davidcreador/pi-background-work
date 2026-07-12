import assert from "node:assert/strict";
import test from "node:test";
import { executeDetachableBash, type ToolResultLike } from "../src/bash.ts";
import { jobIdFor, resolveGroupIdentity } from "../src/identity.ts";
import { runDetachable } from "../src/run-detachable.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Harness {
  registration: any;
  events: Array<{ name: string; payload: any }>;
  pi: { events: { emit(name: string, payload: unknown): void } };
}

function harness(): Harness {
  const events: Array<{ name: string; payload: any }> = [];
  const state: Harness = {
    registration: undefined,
    events,
    pi: { events: { emit(name: string, payload: unknown) { events.push({ name, payload }); if (name.endsWith(":register")) state.registration = payload; } } },
  };
  return state;
}

function base(h: Harness, execute: (signal: AbortSignal, onUpdate: (partial: string) => void) => Promise<string>) {
  return {
    pi: h.pi,
    adapterInstanceId: "adapter-1",
    sessionId: "session-1",
    toolCallId: "call-1",
    toolName: "demo",
    kind: "shell" as const,
    label: "demo",
    mutationRisk: "unknown" as const,
    textOf: (partial: string) => partial,
    execute,
    completionOf: (outcome: any, context: any) => outcome.ok
      ? { status: context.aborted ? "cancelled" as const : "succeeded" as const, summary: "done", output: outcome.result }
      : { status: context.aborted ? "cancelled" as const : "failed" as const, summary: "failed", error: String(outcome.error) },
    promotedResult: (jobId: string) => `promoted:${jobId}`,
  };
}

test("natural completion returns original result and unregisters", async () => {
  const h = harness();
  const result = await runDetachable(base(h, async () => "ok"));
  assert.equal(result, "ok");
  assert.deepEqual(h.events.map((event) => event.name), ["background-work:v1:register", "background-work:v1:unregister"]);
  assert.equal((await h.registration.completion).status, "succeeded");
  assert.equal(h.registration.promote().promoted, false);
});

test("promotion wins the race exactly once and yields the placeholder", async () => {
  const h = harness();
  let release!: (value: string) => void;
  const pending = runDetachable(base(h, () => new Promise<string>((resolve) => { release = resolve; })));
  await tick();
  assert.deepEqual(h.registration.promote(), { promoted: true, jobId: h.registration.jobId });
  assert.equal(h.registration.promote().promoted, false);
  assert.equal(await pending, `promoted:${h.registration.jobId}`);
  release("late");
  assert.equal((await h.registration.completion).output, "late");
  // No unregister after promotion: the coordinator owns the job's lifecycle.
  assert.equal(h.events.filter((event) => event.name.endsWith(":unregister")).length, 0);
});

test("outer abort cancels foreground but is detached after promotion", async () => {
  const h = harness();
  const outer = new AbortController();
  const pending = runDetachable({
    ...base(h, (signal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })),
    outerSignal: outer.signal,
  });
  await tick();
  h.registration.promote();
  outer.abort(new Error("outer interrupt"));
  assert.equal(await pending, `promoted:${h.registration.jobId}`);
  h.registration.cancel();
  assert.equal((await h.registration.completion).status, "cancelled");
});

test("foreground updates stop after promotion; inspection keeps streaming", async () => {
  const h = harness();
  const updates: string[] = [];
  let push!: (partial: string) => void;
  let finish!: (value: string) => void;
  const pending = runDetachable({
    ...base(h, (_signal, onUpdate) => { push = onUpdate; return new Promise<string>((resolve) => { finish = resolve; }); }),
    onUpdate: (partial: string) => updates.push(partial),
  });
  await tick();
  push("before");
  h.registration.promote();
  push("after");
  assert.deepEqual(updates, ["before"]);
  assert.equal(h.registration.inspect().latestOutput, "after");
  assert.equal(h.registration.inspect().state, "background-running");
  finish("done");
  await pending;
});

test("execution failure surfaces to foreground caller when not promoted", async () => {
  const h = harness();
  await assert.rejects(runDetachable(base(h, async () => { throw new Error("boom"); })), /boom/);
  assert.equal((await h.registration.completion).status, "failed");
});

test("500-iteration promotion/completion race has exactly one winner", async () => {
  for (let i = 0; i < 500; i++) {
    const h = harness();
    let release!: (value: string) => void;
    const pending = runDetachable({ ...base(h, () => new Promise<string>((resolve) => { release = resolve; })), toolCallId: `call-${i}` });
    await tick();
    if (i % 2 === 0) {
      release("natural");
      assert.equal(await pending, "natural");
      assert.equal(h.registration.promote().promoted, false);
    } else {
      assert.equal(h.registration.promote().promoted, true);
      assert.equal(await pending, `promoted:${h.registration.jobId}`);
      release("late");
    }
  }
});

test("bash helper maps success, failure text, timeout, and cancellation", async () => {
  const success: ToolResultLike = { content: [{ type: "text", text: "ok" }], details: { fullOutputPath: "/tmp/full" } };
  const h1 = harness();
  const result = await executeDetachableBash({ pi: h1.pi, adapterInstanceId: "a", sessionId: "s", toolCallId: "t1", params: { command: "printf ok" }, execute: async () => success });
  assert.equal((result as ToolResultLike).content[0]!.text, "ok");
  const done = await h1.registration.completion;
  assert.equal(done.status, "succeeded");
  assert.equal(done.artifactPath, "/tmp/full");
  assert.equal(h1.registration.inspect().mutationRisk, "unknown");

  const h2 = harness();
  await executeDetachableBash({ pi: h2.pi, adapterInstanceId: "a", sessionId: "s", toolCallId: "t2", params: { command: "ls" }, execute: async () => ({ content: [{ type: "text", text: "Command timed out after 5 seconds" }] }) });
  assert.equal((await h2.registration.completion).status, "timed-out");
  assert.equal(h2.registration.inspect().mutationRisk, "read-only");

  const h3 = harness();
  const pending = executeDetachableBash({
    pi: h3.pi, adapterInstanceId: "a", sessionId: "s", toolCallId: "t3", params: { command: "sleep 60" },
    execute: (signal) => new Promise<ToolResultLike>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("killed")), { once: true })),
  });
  await tick();
  h3.registration.promote();
  await pending;
  h3.registration.cancel();
  assert.equal((await h3.registration.completion).status, "cancelled");
});

test("identity helpers derive deterministic ids and honor env aliases", () => {
  assert.equal(jobIdFor("s", undefined, "t"), jobIdFor("s", undefined, "t"));
  assert.notEqual(jobIdFor("s", "group-a", "t"), jobIdFor("s", undefined, "t"));
  assert.deepEqual(resolveGroupIdentity({}), {});
  assert.deepEqual(resolveGroupIdentity({ AGENT_HARNESS_ROLE: "advisor", AGENT_HARNESS_MISSION_ID: "m1" }), { role: "advisor", groupId: "m1" });
  assert.deepEqual(
    resolveGroupIdentity({ PI_BACKGROUND_WORK_ROLE: "advisor", PI_BACKGROUND_WORK_GROUP_ID: "g1", AGENT_HARNESS_MISSION_ID: "shadowed" }),
    { role: "advisor", groupId: "g1" },
  );
});

test("throwing completionOf settles as failed completion instead of rejecting", async () => {
  const h = harness();
  const result = await runDetachable({
    ...base(h, async () => "ok"),
    completionOf: () => { throw new Error("mapper bomb"); },
  });
  assert.equal(result, "ok");
  const completion = await h.registration.completion;
  assert.equal(completion.status, "failed");
  assert.match(completion.error, /mapper bomb/);
  assert.equal(completion.summary, "Adapter completion mapping failed.");
});
