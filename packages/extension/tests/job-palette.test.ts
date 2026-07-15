import assert from "node:assert/strict";
import test from "node:test";
import type { BackgroundJobSnapshot } from "@davecodes/pi-background-work-sdk";
import { visibleWidth } from "@earendil-works/pi-tui";
import { JobPalette, type JobPaletteAction, type JobPaletteItem } from "../src/job-palette.ts";

function job(jobId: string, state: BackgroundJobSnapshot["state"], output: string): BackgroundJobSnapshot {
  return {
    jobId,
    sessionId: "session",
    toolCallId: jobId,
    toolName: "bash",
    kind: "shell",
    label: `command ${jobId}`,
    startedAt: Date.now(),
    state,
    mutationRisk: "read-only",
    latestOutput: output,
  };
}

const theme = { fg: (_tone: string, value: string) => value } as any;
const keybindings = {
  matches(data: string, action: string) {
    return ({
      "tui.select.up": "up",
      "tui.select.down": "down",
      "tui.select.pageUp": "pageUp",
      "tui.select.pageDown": "pageDown",
      "tui.select.confirm": "enter",
      "tui.select.cancel": "escape",
      "app.tools.expand": "ctrl+o",
    } as Record<string, string>)[action] === data;
  },
  getKeys(action: string) { return action === "app.tools.expand" ? ["ctrl+o"] : []; },
} as any;

test("job palette navigates live items, expands output, and returns contextual actions", () => {
  let result: JobPaletteAction | undefined;
  const items: JobPaletteItem[] = [
    { job: job("bg-running", "background-running", "running"), canCancel: true },
    { job: job("bg-done", "succeeded", Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n")), canCancel: false, retry: "pending" },
  ];
  const palette = new JobPalette({ requestRender() {} } as any, theme, keybindings, () => items, (value) => { result = value; }, 8_192, 120);
  try {
    let rendered = palette.render(100).join("\n");
    assert.match(rendered, /Background jobs/);
    assert.match(rendered, /c cancel/);
    assert.doesNotMatch(rendered, /r retry/);

    palette.handleInput("down");
    rendered = palette.render(100).join("\n");
    assert.match(rendered, /r retry/);
    assert.doesNotMatch(rendered, /c cancel/);
    assert.doesNotMatch(rendered, /line 5/);

    palette.handleInput("enter");
    assert.match(palette.render(100).join("\n"), /line 5/);
    palette.handleInput("r");
    assert.deepEqual(result, { action: "retry", jobId: "bg-done", queued: false });
  } finally {
    palette.dispose();
  }
});

test("job palette stays within narrow and short terminal bounds", () => {
  const snapshot = { ...job("bg-narrow", "failed", Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n")), error: "failed", artifactPath: "/tmp/full-output.log" };
  const palette = new JobPalette({ requestRender() {}, terminal: { rows: 12 } } as any, theme, keybindings, () => [{ job: snapshot, canCancel: false, retry: "pending" }], () => {}, 8_192, 120);
  try {
    const lines = palette.render(9);
    assert.ok(lines.length <= 11);
    assert.ok(lines.every((line) => visibleWidth(line) <= 9));
    assert.ok(lines.some((line) => line.includes("Esc")));
    assert.match(lines.at(-1) ?? "", /^╰/);
  } finally {
    palette.dispose();
  }
});

test("job palette uses a compact layout below normal terminal dimensions", () => {
  const item = { job: { ...job("bg-tiny", "background-running", "running"), error: "failed" }, canCancel: true };
  for (const rows of [1, 4, 6, 8]) {
    for (const width of [1, 2, 7, 20]) {
      const palette = new JobPalette({ requestRender() {}, terminal: { rows } } as any, theme, keybindings, () => [item], () => {}, 8_192, 120);
      try {
        const lines = palette.render(width);
        assert.ok(lines.length <= Math.max(1, Math.floor(rows * 0.95)));
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
      } finally {
        palette.dispose();
      }
    }
  }
});

test("job palette returns cancel for a cancellable selection and finishes once", () => {
  const results: Array<JobPaletteAction | undefined> = [];
  const item = { job: job("bg-running", "background-running", "running"), canCancel: true };
  const palette = new JobPalette({ requestRender() {} } as any, theme, keybindings, () => [item], (value) => results.push(value), 8_192, 120);
  try {
    palette.handleInput("c");
    palette.handleInput("escape");
    assert.deepEqual(results, [{ action: "cancel", jobId: "bg-running" }]);
  } finally {
    palette.dispose();
  }
});
