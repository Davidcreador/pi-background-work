import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  BACKGROUND_WORK_COMPLETION_TYPE,
  type BackgroundJobTerminalStatus,
} from "@davecodes/pi-background-work-sdk";

export interface BackgroundCompletionMessageDetail {
  jobId: string;
  status: BackgroundJobTerminalStatus;
  durationMs?: number;
  summary: string;
  error?: string;
  artifactPath?: string;
}

export interface BackgroundCompletionMessageDetails {
  version: 1;
  role?: string;
  groupId?: string;
  autoResume?: boolean;
  completions: BackgroundCompletionMessageDetail[];
}

function isCompletionDetail(value: unknown): value is BackgroundCompletionMessageDetail {
  if (typeof value !== "object" || value === null) return false;
  const detail = value as Partial<BackgroundCompletionMessageDetail>;
  return typeof detail.jobId === "string"
    && (detail.status === "succeeded" || detail.status === "failed" || detail.status === "timed-out" || detail.status === "cancelled")
    && typeof detail.summary === "string"
    && (detail.durationMs === undefined || (typeof detail.durationMs === "number" && Number.isFinite(detail.durationMs)))
    && (detail.error === undefined || typeof detail.error === "string")
    && (detail.artifactPath === undefined || typeof detail.artifactPath === "string");
}

function icon(status: BackgroundJobTerminalStatus): string {
  if (status === "succeeded") return "✓";
  if (status === "cancelled") return "■";
  if (status === "timed-out") return "◷";
  return "✗";
}

function duration(ms: number | undefined): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms) ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : undefined;
}

function completionLine(item: BackgroundCompletionMessageDetail): string {
  return `${icon(item.status)} ${[item.summary, duration(item.durationMs), item.jobId].filter(Boolean).join(" · ")}`;
}

export function formatCompletionCard(
  details: BackgroundCompletionMessageDetails,
  content: string,
  expanded: boolean,
  expandKey = "Ctrl+O",
): string {
  const completions = details.completions;
  const unsuccessful = completions.some((item) => item.status === "failed" || item.status === "timed-out");
  const aggregateIcon = unsuccessful ? "✗" : completions.every((item) => item.status === "succeeded") ? "✓" : "■";
  const headline = completions.length === 1
    ? completionLine(completions[0]!)
    : `${aggregateIcon} ${completions.length} background jobs completed`;
  if (expanded) return `${headline}\n\n${content}`;

  const lines = [headline];
  if (completions.length > 1) {
    for (const item of completions.slice(0, 3)) lines.push(`  ${completionLine(item)}`);
    if (completions.length > 3) lines.push(`  … ${completions.length - 3} more`);
  } else if (completions[0]!.error) {
    lines.push(`  ${completions[0]!.error}`);
  }
  const resumeHint = details.autoResume === true ? " · Pi resuming" : details.autoResume === false ? " · ready when you are" : "";
  lines.push(`  ${expandKey} details${resumeHint}`);
  return lines.join("\n");
}

export function registerCompletionMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<BackgroundCompletionMessageDetails>(BACKGROUND_WORK_COMPLETION_TYPE, (message, options, theme) => {
    try {
      const details = message.details;
      if (details?.version !== 1 || !Array.isArray(details.completions) || details.completions.length === 0 || !details.completions.every(isCompletionDetail)) return undefined;
      const content = typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.flatMap((item) => typeof item === "object" && item !== null && item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("\n")
          : undefined;
      if (content === undefined) return undefined;
      const text = formatCompletionCard(details, content, options.expanded, keyText("app.tools.expand"));
      const [headline, ...rest] = text.split("\n");
      const unsuccessful = details.completions.some((item) => item.status === "failed" || item.status === "timed-out");
      const tone = unsuccessful ? "error" : details.completions.every((item) => item.status === "succeeded") ? "success" : "warning";
      return new Text([theme.fg(tone, headline ?? ""), ...rest].join("\n"), 0, 0);
    } catch {
      return undefined;
    }
  });
}
