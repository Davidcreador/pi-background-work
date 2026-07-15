import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

export interface BackgroundWorkConfig {
  enabled: boolean;
  shortcut: string | null;
  completionBehavior: "adaptive" | "notify-and-resume" | "notify-only";
  promotionScope: "all-active";
  shutdownBehavior: "cancel";
  completionDebounceMs: number;
  maxOutputBytes: number;
  maxOutputLines: number;
  mutationWarnings: boolean;
  /** Show a live footer indicator (spinner, counts, elapsed) while background jobs run or completions await delivery. */
  statusIndicator: boolean;
  /**
   * How to hand control back after promotion. The placeholder tool result only
   * asks the model to yield; "interrupt" ends the streaming turn like ESC
   * (promoted jobs survive), "steer" queues an explicit yield instruction into
   * the running turn, "off" relies on the placeholder text alone.
   */
  promotionYield: "interrupt" | "steer" | "off";
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
  completionBehavior: "adaptive",
  promotionScope: "all-active",
  shutdownBehavior: "cancel",
  completionDebounceMs: 200,
  maxOutputBytes: 50 * 1024,
  maxOutputLines: 2_000,
  mutationWarnings: true,
  statusIndicator: true,
  promotionYield: "interrupt",
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
    shortcut: typeof raw.shortcut === "string" ? normalizeShortcut(raw.shortcut) ?? null : null,
    completionBehavior: raw.completionBehavior === "notify-only" || raw.completionBehavior === "notify-and-resume"
      ? raw.completionBehavior
      : "adaptive",
    promotionScope: "all-active",
    shutdownBehavior: "cancel",
    completionDebounceMs: finiteInteger(raw.completionDebounceMs, DEFAULT_BACKGROUND_WORK_CONFIG.completionDebounceMs, 0, 10_000),
    maxOutputBytes: finiteInteger(raw.maxOutputBytes, DEFAULT_BACKGROUND_WORK_CONFIG.maxOutputBytes, 1_024, 1_048_576),
    maxOutputLines: finiteInteger(raw.maxOutputLines, DEFAULT_BACKGROUND_WORK_CONFIG.maxOutputLines, 10, 20_000),
    mutationWarnings: typeof raw.mutationWarnings === "boolean" ? raw.mutationWarnings : DEFAULT_BACKGROUND_WORK_CONFIG.mutationWarnings,
    statusIndicator: typeof raw.statusIndicator === "boolean" ? raw.statusIndicator : DEFAULT_BACKGROUND_WORK_CONFIG.statusIndicator,
    promotionYield: raw.promotionYield === "steer" || raw.promotionYield === "off" ? raw.promotionYield : "interrupt",
    bashTool: raw.bashTool === "off" ? "off" : "wrap",
    subagents: typeof raw.subagents === "boolean" ? raw.subagents : DEFAULT_BACKGROUND_WORK_CONFIG.subagents,
  };
}

export interface LoadedBackgroundWorkConfig {
  config: BackgroundWorkConfig;
  path: string;
  error?: string;
}

export function loadBackgroundWorkConfig(): LoadedBackgroundWorkConfig {
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

export function saveBackgroundWorkConfig(config: BackgroundWorkConfig, configPath = backgroundWorkConfigPath()): { backupPath?: string } {
  let existing: Record<string, unknown> = {};
  let backupPath: string | undefined;
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
      else throw new Error("configuration root is not an object");
    } catch {
      backupPath = `${configPath}.invalid-${Date.now()}.bak`;
      fs.copyFileSync(configPath, backupPath);
    }
  }
  const shortcut = config.shortcut ? normalizeShortcut(config.shortcut) : null;
  if (config.shortcut && !shortcut) throw new Error(`Invalid shortcut '${config.shortcut}'.`);
  const { promotionScope: _promotionScope, shutdownBehavior: _shutdownBehavior, ...persisted } = { ...config, shortcut };
  const next = { ...existing, ...persisted };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, configPath);
  } catch (error) {
    try { fs.rmSync(temporaryPath); } catch { /* best-effort temporary-file cleanup */ }
    throw error;
  }
  return backupPath ? { backupPath } : {};
}

const SHORTCUT_MODIFIER_ORDER = ["ctrl", "shift", "alt", "super"] as const;
const SHORTCUT_MODIFIERS = new Set<string>(SHORTCUT_MODIFIER_ORDER);
const SHORTCUT_ALIASES: Record<string, string> = { esc: "escape", return: "enter" };
const SHORTCUT_SPECIAL_KEYS = new Set([
  "escape", "enter", "tab", "space", "backspace", "delete", "insert", "clear",
  "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);
const SHORTCUT_SYMBOL_KEYS = new Set("`-=[]\\;',./!@#$%^&*()_|~{}:<>?".split(""));

function canonicalShortcut(value: string): string | undefined {
  const parts = value.trim().toLowerCase().split("+");
  const rawKey = parts.pop();
  if (!rawKey || parts.some((part) => !SHORTCUT_MODIFIERS.has(part)) || new Set(parts).size !== parts.length) return undefined;
  const key = SHORTCUT_ALIASES[rawKey] ?? rawKey;
  if (!/^[a-z0-9]$/.test(key) && !SHORTCUT_SPECIAL_KEYS.has(key) && !SHORTCUT_SYMBOL_KEYS.has(key)) return undefined;
  const modifiers = new Set(parts);
  return [...SHORTCUT_MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join("+");
}

export function normalizeShortcut(value: string): string | undefined {
  const shortcut = canonicalShortcut(value);
  if (!shortcut) return undefined;
  const parts = shortcut.split("+");
  const key = parts.pop()!;
  const printable = key.length === 1 || key === "space";
  if (printable && (parts.length === 0 || parts.every((part) => part === "shift"))) return undefined;
  return shortcut;
}

export function isValidShortcut(value: string): boolean {
  return normalizeShortcut(value) !== undefined;
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

function values(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Detect whether `shortcut` collides with an effective Pi binding (defaults merged with user keybindings.json overrides). */
export function detectShortcutConflict(shortcut: string | null, keybindingsPath = path.join(os.homedir(), ".pi", "agent", "keybindings.json")): string | undefined {
  if (!shortcut) return undefined;
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return "invalid shortcut";
  let configured: Record<string, unknown> = {};
  try {
    if (fs.existsSync(keybindingsPath)) configured = JSON.parse(fs.readFileSync(keybindingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    return "unreadable keybindings configuration";
  }
  const defaults: Record<string, string | string[]> = { ...APP_KEYBINDINGS };
  for (const [action, definition] of Object.entries(TUI_KEYBINDINGS)) defaults[action] = definition.defaultKeys;
  const actions = new Set([...Object.keys(defaults), ...Object.keys(configured)]);
  for (const action of actions) {
    const effective = Object.hasOwn(configured, action) ? configured[action] : defaults[action];
    if (values(effective).some((key) => canonicalShortcut(key) === normalized)) return action;
  }
  return undefined;
}
