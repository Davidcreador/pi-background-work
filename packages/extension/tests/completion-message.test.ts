import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCompletionCard,
  registerCompletionMessageRenderer,
  type BackgroundCompletionMessageDetails,
} from "../src/completion-message.ts";

function details(overrides: Partial<BackgroundCompletionMessageDetails["completions"][number]> = {}): BackgroundCompletionMessageDetails {
  return {
    version: 1,
    completions: [{
      jobId: "bg-1234",
      status: "succeeded",
      durationMs: 12_340,
      summary: "Shell command completed.",
      ...overrides,
    }],
  };
}

test("collapsed completion card shows a compact summary and expansion hint", () => {
  assert.equal(
    formatCompletionCard(details(), "full output", false, "Ctrl+O"),
    "✓ Shell command completed. · 12.3s · bg-1234\n  Ctrl+O details",
  );
});

test("collapsed completion card explains whether Pi will resume", () => {
  assert.match(formatCompletionCard({ ...details(), autoResume: true }, "output", false), /Ctrl\+O details · Pi resuming$/);
  assert.match(formatCompletionCard({ ...details(), autoResume: false }, "output", false), /Ctrl\+O details · ready when you are$/);
});

test("collapsed failed completion includes the bounded error", () => {
  assert.equal(
    formatCompletionCard(details({ status: "failed", summary: "Shell command failed.", error: "exit 7" }), "full output", false),
    "✗ Shell command failed. · 12.3s · bg-1234\n  exit 7\n  Ctrl+O details",
  );
});

test("completion renderer rejects malformed or hostile persisted messages", () => {
  let renderer!: (message: any, options: any, theme: any) => unknown;
  registerCompletionMessageRenderer({ registerMessageRenderer(_type: string, value: typeof renderer) { renderer = value; } } as any);
  const theme = { fg: (_tone: string, value: string) => value };
  assert.equal(renderer({ details: { version: 1, completions: [null] }, content: "output" }, { expanded: false }, theme), undefined);
  assert.equal(renderer({ details: details(), content: { invalid: true } }, { expanded: false }, theme), undefined);
  const hostile = Object.defineProperty({}, "details", { get() { throw new Error("boom"); } });
  assert.doesNotThrow(() => assert.equal(renderer(hostile, { expanded: false }, theme), undefined));
});

test("cancelled completion batches do not use a success headline", () => {
  const cancelled: BackgroundCompletionMessageDetails = {
    version: 1,
    completions: ["bg-1", "bg-2"].map((jobId) => ({ jobId, status: "cancelled", summary: "Cancelled." })),
  };
  assert.match(formatCompletionCard(cancelled, "output", false), /^■ 2 background jobs completed/);
  cancelled.completions[0]!.status = "succeeded";
  assert.match(formatCompletionCard(cancelled, "output", false), /^■ 2 background jobs completed/);
});

test("collapsed batch previews three jobs while expanded card exposes full content", () => {
  const batch: BackgroundCompletionMessageDetails = {
    version: 1,
    completions: Array.from({ length: 5 }, (_, index) => ({
      jobId: `bg-${index}`,
      status: index === 1 ? "failed" as const : "succeeded" as const,
      durationMs: 1_000 + index,
      summary: `Job ${index} completed.`,
    })),
  };
  const collapsed = formatCompletionCard(batch, "full batch output", false);
  assert.match(collapsed, /^✗ 5 background jobs completed/);
  assert.match(collapsed, /… 2 more/);
  assert.doesNotMatch(collapsed, /Job 4 completed/);
  assert.equal(formatCompletionCard(batch, "full batch output", true), "✗ 5 background jobs completed\n\nfull batch output");
});
