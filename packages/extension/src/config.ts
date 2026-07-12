import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

export interface BackgroundWorkConfig {
  enabled: boolean;
  shortcut: string | null;
  completionBehavior: "notify-and-resume" | "notify-only";
  promotionScope: "all-active";
  shutdownBehavior: "cancel";
  completionDebounceMs: number;
  maxOutputBytes: number;
  maxOutputLines: number;
  mutationWarnings: boolean;
  /** Show a live footer indicator (spinner, counts, elapsed) while background jobs run or completions await delivery. */
  statusIndicator: boolean;
  /** "wrap" registers a promotion-capable Bash tool; "off" leaves the effective Bash tool untouched. */
  bashTool: "wrap" | "off";
  /** Register the bundled promotion-capable subagent tool (@davecodes/pi-subagents). */
  subagents: boolean;
}

export const DEFAULT_BACKGROUND_WORK_CONFIG: BackgroundWorkConfig = {
  // Installing the extension is consent: enabled by default, unlike the
  // shortcut which stays unset to avoid overriding any Pi keybinding.
  enabled: true,
  shortcut: null,
  completionBehavior: "notify-and-resume",
  promotionScope: "all-active",
  shutdownBehavior: "cancel",
  completionDebounceMs: 200,
  maxOutputBytes: 50 * 1024,
  maxOutputLines: 2_000,
  mutationWarnings: true,
  statusIndicator: true,
  bashTool: "wrap",
  subagents: true,
};

export function backgroundWorkConfigPath(): string {
  return process.env.PI_BACKGROUND_WORK_CONFIG
    ? path.resolve(process.env.PI_BACKGROUND_WORK_CONFIG)
    : path.join(os.homedir(), ".pi", "agent", "background-work.json");
}

function finiteInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function parseBackgroundWorkConfig(value: unknown): BackgroundWorkConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ...DEFAULT_BACKGROUND_WORK_CONFIG };
  const raw = value as Record<string, unknown>;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_BACKGROUND_WORK_CONFIG.enabled,
    shortcut: typeof raw.shortcut === "string" && raw.shortcut.trim() ? raw.shortcut.trim() : null,
    completionBehavior: raw.completionBehavior === "notify-only" ? "notify-only" : "notify-and-resume",
    promotionScope: "all-active",
    shutdownBehavior: "cancel",
    completionDebounceMs: finiteInteger(raw.completionDebounceMs, DEFAULT_BACKGROUND_WORK_CONFIG.completionDebounceMs, 0, 10_000),
    maxOutputBytes: finiteInteger(raw.maxOutputBytes, DEFAULT_BACKGROUND_WORK_CONFIG.maxOutputBytes, 1_024, 1_048_576),
    maxOutputLines: finiteInteger(raw.maxOutputLines, DEFAULT_BACKGROUND_WORK_CONFIG.maxOutputLines, 10, 20_000),
    mutationWarnings: typeof raw.mutationWarnings === "boolean" ? raw.mutationWarnings : DEFAULT_BACKGROUND_WORK_CONFIG.mutationWarnings,
    statusIndicator: typeof raw.statusIndicator === "boolean" ? raw.statusIndicator : DEFAULT_BACKGROUND_WORK_CONFIG.statusIndicator,
    bashTool: raw.bashTool === "off" ? "off" : "wrap",
    subagents: typeof raw.subagents === "boolean" ? raw.subagents : DEFAULT_BACKGROUND_WORK_CONFIG.subagents,
  };
}

export function loadBackgroundWorkConfig(): { config: BackgroundWorkConfig; path: string; error?: string } {
  const configPath = backgroundWorkConfigPath();
  try {
    if (!fs.existsSync(configPath)) return { config: { ...DEFAULT_BACKGROUND_WORK_CONFIG }, path: configPath };
    return { config: parseBackgroundWorkConfig(JSON.parse(fs.readFileSync(configPath, "utf8"))), path: configPath };
  } catch (error) {
    // An unreadable config never silently enables promotion; fail disabled and surface the error.
    return {
      config: { ...DEFAULT_BACKGROUND_WORK_CONFIG, enabled: false },
      path: configPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Effective Pi app-level keybindings. Pi does not export these; the list
 * mirrors interactive-mode defaults so shortcut conflicts are detected against
 * what a stock install actually binds.
 */
const APP_KEYBINDINGS: Record<string, string | string[]> = {
  "app.interrupt": "escape", "app.clear": "ctrl+c", "app.exit": "ctrl+d",
  "app.suspend": process.platform === "win32" ? [] : "ctrl+z",
  "app.thinking.cycle": "shift+tab", "app.model.cycleForward": "ctrl+p",
  "app.model.cycleBackward": "shift+ctrl+p", "app.model.select": "ctrl+l",
  "app.tools.expand": "ctrl+o", "app.thinking.toggle": "ctrl+t",
  "app.session.toggleNamedFilter": "ctrl+n", "app.editor.external": "ctrl+g",
  "app.message.followUp": "alt+enter", "app.message.dequeue": "alt+up",
  "app.clipboard.pasteImage": process.platform === "win32" ? "alt+v" : "ctrl+v",
};

function values(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/** Detect whether `shortcut` collides with an effective Pi binding (defaults merged with user keybindings.json overrides). */
export function detectShortcutConflict(shortcut: string | null, keybindingsPath = path.join(os.homedir(), ".pi", "agent", "keybindings.json")): string | undefined {
  if (!shortcut) return undefined;
  const normalized = shortcut.toLowerCase();
  let configured: Record<string, string | string[]> = {};
  try {
    if (fs.existsSync(keybindingsPath)) configured = JSON.parse(fs.readFileSync(keybindingsPath, "utf8")) as Record<string, string | string[]>;
  } catch {
    return "unreadable keybindings configuration";
  }
  const defaults: Record<string, string | string[]> = { ...APP_KEYBINDINGS };
  for (const [action, definition] of Object.entries(TUI_KEYBINDINGS)) defaults[action] = definition.defaultKeys;
  const actions = new Set([...Object.keys(defaults), ...Object.keys(configured)]);
  for (const action of actions) {
    const effective = Object.hasOwn(configured, action) ? configured[action] : defaults[action];
    if (values(effective).some((key) => key.toLowerCase() === normalized)) return action;
  }
  return undefined;
}
