import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { executeDetachableBash, type ToolResultLike } from "@davecodes/pi-background-work-sdk";

/** Drive Pi's real bash tool through the SDK exactly as src/bash-tool.ts wires it. */
async function run(command: string, timeout?: number) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bg-bash-"));
  const tool = createBashTool(cwd);
  let registration: any;
  const pi = { events: { emit(name: string, payload: unknown) { if (name.endsWith(":register")) registration = payload; } } };
  const returned = executeDetachableBash({
    pi,
    adapterInstanceId: "test-adapter",
    sessionId: "test-session",
    toolCallId: Math.random().toString(16),
    params: { command },
    execute: (signal, update) =>
      tool.execute("inner", { command, timeout }, signal, update as never) as Promise<ToolResultLike>,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  registration.promote();
  await returned;
  return { cwd, registration, completion: registration.completion as Promise<any> };
}

test("real Bash promotion reports success, nonzero, timeout, and truncation", async () => {
  assert.equal((await (await run("printf success")).completion).status, "succeeded");
  assert.equal((await (await run("exit 7")).completion).status, "failed");
  assert.equal((await (await run("sleep 2", 0.05)).completion).status, "timed-out");
  const truncated = await (await run("python3 -c 'print(\"x\"*70000)'")).completion;
  assert.equal(truncated.status, "succeeded");
  assert.ok(truncated.artifactPath);
  assert.ok(fs.existsSync(truncated.artifactPath));
});

test("real promoted Bash cancellation kills its process group descendants", async () => {
  const pidFile = "grandchild.pid";
  const execution = await run(`sleep 60 & echo $! > ${pidFile}; wait`);
  for (let i = 0; i < 50 && !fs.existsSync(path.join(execution.cwd, pidFile)); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const grandchild = Number(fs.readFileSync(path.join(execution.cwd, pidFile), "utf8").trim());
  execution.registration.cancel();
  const completion = await execution.completion;
  assert.equal(completion.status, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 100));
  let alive = true;
  try { process.kill(grandchild, 0); } catch { alive = false; }
  assert.equal(alive, false);
});
