import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_BACKGROUND_WORK_CONFIG,
  detectShortcutConflict,
  normalizeShortcut,
  saveBackgroundWorkConfig,
  type BackgroundWorkConfig,
  type LoadedBackgroundWorkConfig,
} from "./config.ts";

const onOff = (value: boolean) => value ? "on" : "off";
const completionLabel = (value: BackgroundWorkConfig["completionBehavior"]) => value === "adaptive"
  ? "resume if conversation has not moved on"
  : value === "notify-and-resume" ? "always resume" : "notify only";
const handoffLabel = (value: BackgroundWorkConfig["promotionYield"]) => value === "interrupt"
  ? "return control immediately"
  : value === "steer" ? "ask model to stop" : "placeholder only";

async function chooseCompletionBehavior(ctx: ExtensionContext, draft: BackgroundWorkConfig): Promise<void> {
  const choices = [
    "Adaptive — resume only when the conversation has not moved on",
    "Always resume",
    "Notify only",
  ];
  const selected = await ctx.ui.select("Completion behavior", choices);
  if (selected === choices[0]) draft.completionBehavior = "adaptive";
  if (selected === choices[1]) draft.completionBehavior = "notify-and-resume";
  if (selected === choices[2]) draft.completionBehavior = "notify-only";
}

async function choosePromotionYield(ctx: ExtensionContext, draft: BackgroundWorkConfig): Promise<void> {
  const choices = ["Interrupt — return control immediately", "Steer — ask the model to stop", "Off — placeholder only"];
  const selected = await ctx.ui.select("Promotion handoff", choices);
  if (selected === choices[0]) draft.promotionYield = "interrupt";
  if (selected === choices[1]) draft.promotionYield = "steer";
  if (selected === choices[2]) draft.promotionYield = "off";
}

async function chooseShortcut(ctx: ExtensionContext, draft: BackgroundWorkConfig): Promise<void> {
  const choices = ["Set shortcut", "Clear shortcut", "Back"];
  const selected = await ctx.ui.select("Promotion shortcut", choices);
  if (selected === choices[1]) {
    draft.shortcut = null;
    return;
  }
  if (selected !== choices[0]) return;
  const value = await ctx.ui.input("Promotion shortcut", draft.shortcut ?? "f12");
  if (value === undefined) return;
  const candidate = value.trim();
  const shortcut = normalizeShortcut(candidate);
  if (!shortcut) {
    ctx.ui.notify(`Invalid shortcut '${candidate}'. Try f12 or ctrl+shift+b.`, "warning");
    return;
  }
  const conflict = detectShortcutConflict(shortcut);
  if (conflict) {
    ctx.ui.notify(`Shortcut '${candidate}' conflicts with ${conflict}.`, "warning");
    return;
  }
  draft.shortcut = shortcut;
}

export async function openBackgroundWorkConfig(ctx: ExtensionCommandContext, loaded: LoadedBackgroundWorkConfig): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/background-config requires TUI or RPC mode.", "warning");
    return;
  }
  if (loaded.error) {
    const confirmed = await ctx.ui.confirm(
      "Repair background-work configuration?",
      `${loaded.path}\n${loaded.error}\n\nThe invalid file will be backed up before defaults are restored.`,
    );
    if (!confirmed) return;
    let saved: { backupPath?: string };
    const repaired = { ...DEFAULT_BACKGROUND_WORK_CONFIG };
    try {
      saved = saveBackgroundWorkConfig(repaired, loaded.path);
      loaded.config = repaired;
      loaded.error = undefined;
    } catch (error) {
      ctx.ui.notify(`Could not repair configuration: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
    ctx.ui.notify(`Configuration repaired${saved.backupPath ? `; backup: ${saved.backupPath}` : ""}. Reloading…`, "info");
    try {
      await ctx.reload();
    } catch (error) {
      ctx.ui.notify(`Configuration repaired, but reload failed: ${error instanceof Error ? error.message : String(error)}. Run /reload to apply it.`, "error");
    }
    return;
  }

  const draft = { ...loaded.config };
  const original = JSON.stringify(draft);
  while (true) {
    const options = [
      `Enabled: ${onOff(draft.enabled)}`,
      `Shortcut: ${draft.shortcut ?? "none"}`,
      `Completion: ${completionLabel(draft.completionBehavior)}`,
      `Promotion handoff: ${handoffLabel(draft.promotionYield)}`,
      `Status indicator: ${onOff(draft.statusIndicator)}`,
      `Mutation warnings: ${onOff(draft.mutationWarnings)}`,
      `Bash integration: ${draft.bashTool === "wrap" ? "bundled wrapper" : "external/off"}`,
      `Bundled subagents: ${onOff(draft.subagents)}`,
      `Save and reload${JSON.stringify(draft) === original ? " (no changes)" : ""}`,
      "Cancel",
    ];
    const selected = await ctx.ui.select("Background work settings", options);
    const index = selected ? options.indexOf(selected) : -1;
    if (index < 0 || index === 9) return;
    if (index === 0) draft.enabled = !draft.enabled;
    if (index === 1) await chooseShortcut(ctx, draft);
    if (index === 2) await chooseCompletionBehavior(ctx, draft);
    if (index === 3) await choosePromotionYield(ctx, draft);
    if (index === 4) draft.statusIndicator = !draft.statusIndicator;
    if (index === 5) draft.mutationWarnings = !draft.mutationWarnings;
    if (index === 6) draft.bashTool = draft.bashTool === "wrap" ? "off" : "wrap";
    if (index === 7) draft.subagents = !draft.subagents;
    if (index !== 8) continue;
    if (JSON.stringify(draft) === original) {
      ctx.ui.notify("No configuration changes to save.", "info");
      return;
    }
    try {
      saveBackgroundWorkConfig(draft, loaded.path);
      loaded.config = { ...draft };
      loaded.error = undefined;
    } catch (error) {
      ctx.ui.notify(`Could not save configuration: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
    ctx.ui.notify(`Saved ${loaded.path}. Reloading…`, "info");
    try {
      await ctx.reload();
    } catch (error) {
      ctx.ui.notify(`Configuration saved, but reload failed: ${error instanceof Error ? error.message : String(error)}. Run /reload to apply it.`, "error");
    }
    return;
  }
}
