import type { BackgroundJobSnapshot, BackgroundJobState } from "@davecodes/pi-background-work-sdk";

const ACTIVE_STATES = new Set<BackgroundJobState>(["foreground-running", "background-running", "cancelling"]);

function stateIcon(state: BackgroundJobState): string {
  if (state === "foreground-running") return "→";
  if (state === "background-running") return "●";
  if (state === "cancelling" || state === "timed-out") return "◷";
  if (state === "succeeded") return "✓";
  if (state === "cancelled") return "■";
  return "✗";
}

function stateLabel(state: BackgroundJobState): string {
  if (state === "foreground-running") return "foreground";
  if (state === "background-running") return "running";
  if (state === "timed-out") return "timed out";
  return state;
}

function elapsed(snapshot: BackgroundJobSnapshot, now: number): string {
  return `${Math.max(0, ((snapshot.finishedAt ?? now) - snapshot.startedAt) / 1000).toFixed(1)}s`;
}

export function formatJobLabel(snapshot: BackgroundJobSnapshot, now = Date.now()): string {
  const label = snapshot.label.replaceAll(/[\r\n]+/g, " ").slice(0, 120);
  return `${stateIcon(snapshot.state)} ${label} · ${snapshot.kind} ${stateLabel(snapshot.state)} · ${elapsed(snapshot, now)} · ${snapshot.jobId}`;
}

export function sortJobsForDisplay(snapshots: BackgroundJobSnapshot[]): BackgroundJobSnapshot[] {
  return [...snapshots].sort((left, right) => {
    const leftActive = ACTIVE_STATES.has(left.state);
    const rightActive = ACTIVE_STATES.has(right.state);
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    return leftActive ? left.startedAt - right.startedAt : (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt);
  });
}

function prefixByBytes(value: string, maxBytes: number): string {
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end)) > maxBytes) end -= 1;
  return value.slice(0, end);
}

function suffixByBytes(value: string, maxBytes: number): string {
  let start = Math.max(0, value.length - maxBytes);
  while (start < value.length && Buffer.byteLength(value.slice(start)) > maxBytes) start += 1;
  return value.slice(start);
}

export function boundedJobOutput(value: string, maxBytes: number, maxLines: number): string {
  if (!value || maxBytes <= 0 || maxLines <= 0) return "";
  const lines = value.split("\n");
  let text = value;
  if (lines.length > maxLines) {
    if (maxLines === 1) {
      text = `[${lines.length - 1} lines omitted] ${lines.at(-1) ?? ""}`;
    } else {
      const headCount = Math.floor((maxLines - 1) / 2);
      const tailCount = maxLines - headCount - 1;
      text = [
        ...lines.slice(0, headCount),
        `[${lines.length - headCount - tailCount} lines omitted]`,
        ...lines.slice(lines.length - tailCount),
      ].join("\n");
    }
  }
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const marker = " … [output truncated] … ";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker));
  const headBytes = Math.ceil(budget / 2);
  return `${prefixByBytes(text, headBytes)}${marker}${suffixByBytes(text, budget - headBytes)}`;
}
