import assert from "node:assert/strict";
import test from "node:test";
import type { BackgroundJobSnapshot } from "@davecodes/pi-background-work-sdk";
import {
  boundedJobOutput,
  formatJobLabel,
  sortJobsForDisplay,
} from "../src/job-presentation.ts";

function job(jobId: string, state: BackgroundJobSnapshot["state"], startedAt: number, finishedAt?: number): BackgroundJobSnapshot {
  return {
    jobId,
    sessionId: "session",
    toolCallId: jobId,
    toolName: "bash",
    kind: "shell",
    label: `command ${jobId}`,
    startedAt,
    finishedAt,
    state,
    mutationRisk: "read-only",
  };
}

test("job labels lead with human context and keep the stable id", () => {
  assert.equal(
    formatJobLabel(job("bg-1", "background-running", 1_000), 3_500),
    "● command bg-1 · shell running · 2.5s · bg-1",
  );
});

test("active jobs sort before newest-first terminal history", () => {
  const sorted = sortJobsForDisplay([
    job("old-done", "succeeded", 1, 10),
    job("new-active", "background-running", 5),
    job("new-done", "failed", 4, 20),
    job("old-active", "cancelling", 2),
  ]);
  assert.deepEqual(sorted.map((item) => item.jobId), ["old-active", "new-active", "new-done", "old-done"]);
});

test("job output preview preserves head and tail within line and byte limits", () => {
  const lineBound = boundedJobOutput(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"), 10_000, 5);
  assert.equal(lineBound.split("\n").length, 5);
  assert.match(lineBound, /^line 0\nline 1\n\[16 lines omitted\]/);
  assert.match(lineBound, /line 18\nline 19$/);
  const oneLine = boundedJobOutput("first\nlast", 10_000, 1);
  assert.equal(oneLine.split("\n").length, 1);
  assert.match(oneLine, /last$/);

  const byteBound = boundedJobOutput("start-" + "😀".repeat(100) + "-finish", 80, 20);
  assert.ok(Buffer.byteLength(byteBound) <= 80);
  assert.match(byteBound, /^start-/);
  assert.match(byteBound, /-finish$/);
  assert.match(byteBound, /output truncated/);
});
