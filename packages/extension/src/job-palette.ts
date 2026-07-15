import type {
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { BackgroundJobSnapshot } from "@davecodes/pi-background-work-sdk";
import {
  decodeKittyPrintable,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { boundedJobOutput, formatJobLabel } from "./job-presentation.ts";

export interface JobPaletteItem {
  job: BackgroundJobSnapshot;
  canCancel: boolean;
  retry?: "pending" | "queued";
}

export type JobPaletteAction =
  | { action: "cancel"; jobId: string }
  | { action: "retry"; jobId: string; queued: boolean };

export class JobPalette implements Component {
  private selectedJobId: string | undefined;
  private expanded = false;
  private finished = false;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly tui: Pick<TUI, "requestRender"> & { terminal?: { rows: number } },
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly getItems: () => JobPaletteItem[],
    private readonly done: (result: JobPaletteAction | undefined) => void,
    private readonly maxOutputBytes: number,
    private readonly maxOutputLines: number,
  ) {
    this.timer = setInterval(() => this.tui.requestRender(), 500);
    this.timer.unref?.();
  }

  private selection(): { items: JobPaletteItem[]; index: number; item?: JobPaletteItem } {
    const items = this.getItems();
    let index = this.selectedJobId ? items.findIndex((item) => item.job.jobId === this.selectedJobId) : 0;
    if (index < 0) index = Math.min(items.length - 1, 0);
    const item = items[index];
    this.selectedJobId = item?.job.jobId;
    return { items, index, item };
  }

  private finish(result: JobPaletteAction | undefined): void {
    if (this.finished) return;
    this.finished = true;
    clearInterval(this.timer);
    this.done(result);
  }

  handleInput(data: string): void {
    const current = this.selection();
    if (this.keybindings.matches(data, "tui.select.cancel") || (decodeKittyPrintable(data) ?? data) === "q") {
      this.finish(undefined);
      return;
    }
    if (!current.item) return;
    if (this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.select.pageUp")) {
      const step = this.keybindings.matches(data, "tui.select.pageUp") ? 5 : 1;
      this.selectedJobId = current.items[Math.max(0, current.index - step)]?.job.jobId;
      this.expanded = false;
    } else if (this.keybindings.matches(data, "tui.select.down") || this.keybindings.matches(data, "tui.select.pageDown")) {
      const step = this.keybindings.matches(data, "tui.select.pageDown") ? 5 : 1;
      this.selectedJobId = current.items[Math.min(current.items.length - 1, current.index + step)]?.job.jobId;
      this.expanded = false;
    } else if (this.keybindings.matches(data, "tui.select.confirm") || this.keybindings.matches(data, "app.tools.expand")) {
      this.expanded = !this.expanded;
    } else {
      const printable = decodeKittyPrintable(data) ?? data;
      if (printable === "c" && current.item.canCancel) this.finish({ action: "cancel", jobId: current.item.job.jobId });
      if (printable === "r" && current.item.retry) this.finish({ action: "retry", jobId: current.item.job.jobId, queued: current.item.retry === "queued" });
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const { items, index, item } = this.selection();
    if (width <= 0) return [];
    const maxRows = Math.max(1, Math.floor(Math.max(1, this.tui.terminal?.rows ?? 32) * 0.95));
    if (width < 8 || maxRows < 8) {
      const fit = (value: string) => truncateToWidth(value, width, "…", true);
      const shortHints = ["q"];
      if (item?.canCancel) shortHints.push("c");
      if (item?.retry) shortHints.push("r");
      const actionHint = width < 3
        ? "q"
        : width < 8 ? shortHints.join(" ") : ["Esc close", item?.canCancel ? "c cancel" : "", item?.retry ? "r retry" : ""].filter(Boolean).join(" · ");
      const lines: string[] = [];
      if (maxRows >= 3) lines.push(fit(`Jobs${item ? ` ${index + 1}/${items.length}` : ""}`));
      if (maxRows >= 2) lines.push(fit(item ? formatJobLabel(item.job) : "No jobs"));
      if (maxRows >= 4 && item) {
        const detail = (item.job.error?.replaceAll(/[\r\n]+/g, " ")
          ?? boundedJobOutput(item.job.latestOutput ?? "", Math.min(this.maxOutputBytes, 512), 1))
          || "(no output yet)";
        lines.push(fit(detail));
      }
      lines.push(fit(actionHint));
      return lines;
    }
    const innerWidth = width - 2;
    const border = (value: string) => this.theme.fg("border", value);
    const row = (value = "") => `${border("│")}${truncateToWidth(value, innerWidth, "…", true)}${border("│")}`;
    const titledBorder = (left: string, right: string, title: string) => {
      const label = truncateToWidth(` ${title} `, Math.max(0, innerWidth - 1), "");
      const fill = "─".repeat(Math.max(0, innerWidth - visibleWidth(label) - 1));
      return `${border(`${left}─`)}${this.theme.fg("accent", label)}${border(`${fill}${right}`)}`;
    };
    const lines = [titledBorder("╭", "╮", `Background jobs${item ? ` ${index + 1}/${items.length}` : ""}`)];

    if (!item) {
      lines.push(row(` ${this.theme.fg("dim", "No jobs in this session.")}`));
      lines.push(row(` ${this.theme.fg("dim", "Esc close")}`));
    } else {
      let spareRows = Math.max(0, maxRows - 8);
      const showError = Boolean(item.job.error) && spareRows-- > 0;
      const showNavigation = spareRows-- > 0;
      const showArtifact = Boolean(item.job.artifactPath) && spareRows-- > 0;
      const showSpacer = spareRows > 0;
      const chromeRows = 6 + Number(showError) + Number(showNavigation) + Number(showArtifact) + Number(showSpacer);
      const contentRows = Math.max(2, maxRows - chromeRows);
      const visibleCount = Math.min(5, items.length, Math.max(1, Math.floor(contentRows / 2)));
      const outputRows = Math.max(1, contentRows - visibleCount);
      const start = Math.max(0, Math.min(index - Math.floor(visibleCount / 2), items.length - visibleCount));
      for (let itemIndex = start; itemIndex < start + visibleCount; itemIndex += 1) {
        const candidate = items[itemIndex]!;
        const selected = itemIndex === index;
        const marker = selected ? this.theme.fg("accent", "›") : " ";
        const label = selected ? this.theme.fg("accent", formatJobLabel(candidate.job)) : this.theme.fg("text", formatJobLabel(candidate.job));
        lines.push(row(` ${marker} ${label}`));
      }

      lines.push(titledBorder("├", "┤", "Details"));
      lines.push(row(` ${this.theme.fg("muted", `Mutation risk: ${item.job.mutationRisk}`)}`));
      if (showError) lines.push(row(` ${this.theme.fg("error", item.job.error!.replaceAll(/[\r\n]+/g, " ").slice(0, 180))}`));
      const output = boundedJobOutput(
        item.job.latestOutput ?? "",
        Math.min(this.maxOutputBytes, this.expanded ? 8 * 1024 : 2 * 1024),
        Math.min(this.maxOutputLines, this.expanded ? outputRows : Math.min(4, outputRows)),
      );
      lines.push(row(` ${this.theme.fg("dim", "Output")}`));
      for (const outputLine of (output || "(no output yet)").split("\n")) lines.push(row(`   ${this.theme.fg("text", outputLine)}`));
      if (showArtifact) lines.push(row(` ${this.theme.fg("muted", `Full output: ${item.job.artifactPath!.slice(0, 180)}`)}`));
      if (showSpacer) lines.push(row());
      const actionHints = ["Esc close"];
      if (item.canCancel) actionHints.push("c cancel");
      if (item.retry) actionHints.push("r retry");
      lines.push(row(` ${this.theme.fg("dim", actionHints.join(" · "))}`));
      if (showNavigation) {
        const navigationHints = ["↑↓ select", `Enter/${this.keybindings.getKeys("app.tools.expand").join("/") || "Ctrl+O"} output`];
        lines.push(row(` ${this.theme.fg("dim", navigationHints.join(" · "))}`));
      }
    }
    lines.push(`${border("╰")}${border("─".repeat(innerWidth))}${border("╯")}`);
    return lines;
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.timer);
  }
}

export function openJobPalette(
  ctx: ExtensionContext,
  getItems: () => JobPaletteItem[],
  options: { maxOutputBytes: number; maxOutputLines: number },
): Promise<JobPaletteAction | undefined> {
  return ctx.ui.custom<JobPaletteAction | undefined>(
    (tui, theme, keybindings, done) => new JobPalette(tui, theme, keybindings, getItems, done, options.maxOutputBytes, options.maxOutputLines),
    { overlay: true, overlayOptions: { anchor: "center", width: "80%", minWidth: 56, maxHeight: "95%" } },
  );
}
