import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openBackgroundWorkConfig } from "../src/config-ui.ts";
import {
  DEFAULT_BACKGROUND_WORK_CONFIG,
  isValidShortcut,
  normalizeShortcut,
  parseBackgroundWorkConfig,
  saveBackgroundWorkConfig,
} from "../src/config.ts";

test("config writer preserves unknown fields and backs up malformed input", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-config-"));
  const configPath = path.join(dir, "background-work.json");
  fs.writeFileSync(configPath, JSON.stringify({ futureOption: "keep", completionBehavior: "notify-only" }));
  saveBackgroundWorkConfig({ ...DEFAULT_BACKGROUND_WORK_CONFIG, statusIndicator: false }, configPath);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(saved.futureOption, "keep");
  assert.equal(saved.statusIndicator, false);
  assert.equal(saved.promotionScope, undefined);
  assert.equal(saved.shutdownBehavior, undefined);

  fs.writeFileSync(configPath, "{broken");
  const repaired = saveBackgroundWorkConfig({ ...DEFAULT_BACKGROUND_WORK_CONFIG }, configPath);
  assert.ok(repaired.backupPath);
  assert.equal(fs.readFileSync(repaired.backupPath!, "utf8"), "{broken");
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).completionBehavior, "adaptive");
});

test("shortcut validation normalizes modifiers and rejects editor input", () => {
  for (const shortcut of ["f12", "ctrl+shift+b", "shift+ctrl+p", "escape", "pageUp", "ctrl+/"]) assert.equal(isValidShortcut(shortcut), true);
  for (const shortcut of ["", "a", "/", "shift+a", "ctrl+", "ctrl+ctrl+b", "ctrl++b", "banana", "hyper+b"]) assert.equal(isValidShortcut(shortcut), false);
  assert.equal(normalizeShortcut("shift+ctrl+p"), "ctrl+shift+p");
  assert.equal(normalizeShortcut("return"), "enter");
  assert.equal(normalizeShortcut("pageUp"), "pageup");
  assert.equal(parseBackgroundWorkConfig({ shortcut: "ctrl++b" }).shortcut, null);
  assert.equal(parseBackgroundWorkConfig({ shortcut: "shift+ctrl+b" }).shortcut, "ctrl+shift+b");
});

test("interactive config repairs malformed JSON with a backup", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-config-repair-"));
  const configPath = path.join(dir, "background-work.json");
  fs.writeFileSync(configPath, "{broken");
  let reloads = 0; const notices: string[] = [];
  const ctx: any = {
    hasUI: true,
    ui: { confirm: async () => true, notify(message: string) { notices.push(message); } },
    async reload() { reloads += 1; },
  };
  await openBackgroundWorkConfig(ctx, { config: { ...DEFAULT_BACKGROUND_WORK_CONFIG, enabled: false }, path: configPath, error: "Unexpected token" });
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).enabled, true);
  assert.equal(reloads, 1);
  assert.ok(notices.some((notice) => notice.includes("backup:")));
  assert.ok(fs.readdirSync(dir).some((name) => name.endsWith(".bak")));
});

test("config writer rejects unsafe shortcuts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-config-shortcut-"));
  const configPath = path.join(dir, "background-work.json");
  assert.throws(() => saveBackgroundWorkConfig({ ...DEFAULT_BACKGROUND_WORK_CONFIG, shortcut: "a" }, configPath), /Invalid shortcut/);
  assert.equal(fs.existsSync(configPath), false);
});

test("interactive config edits, saves, and reloads", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-config-ui-"));
  const configPath = path.join(dir, "background-work.json");
  fs.writeFileSync(configPath, JSON.stringify({ futureOption: true, completionBehavior: "notify-and-resume" }));
  const config = parseBackgroundWorkConfig({ completionBehavior: "notify-and-resume" });
  let settingsVisits = 0; let reloads = 0; const notices: string[] = [];
  const ctx: any = {
    hasUI: true,
    ui: {
      notify(message: string) { notices.push(message); },
      select: async (title: string, options: string[]) => {
        if (title === "Completion behavior") return options[0];
        if (title === "Background work settings") return settingsVisits++ === 0 ? options[2] : options[8];
        return undefined;
      },
    },
    async reload() { reloads += 1; },
  };
  await openBackgroundWorkConfig(ctx, { config, path: configPath });
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(saved.completionBehavior, "adaptive");
  assert.equal(saved.futureOption, true);
  assert.equal(reloads, 1);
  assert.ok(notices.some((notice) => notice.includes("Reloading")));
});

test("failed reload keeps the saved draft for the next config edit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-config-reload-"));
  const configPath = path.join(dir, "background-work.json");
  fs.writeFileSync(configPath, JSON.stringify({ completionBehavior: "notify-only", statusIndicator: true }));
  const loaded = { config: parseBackgroundWorkConfig({ completionBehavior: "notify-only", statusIndicator: true }), path: configPath };

  let visits = 0;
  await openBackgroundWorkConfig({
    hasUI: true,
    ui: {
      notify() {},
      select: async (title: string, options: string[]) => title === "Completion behavior" ? options[0] : visits++ === 0 ? options[2] : options[8],
    },
    async reload() { throw new Error("reload unavailable"); },
  } as any, loaded);

  visits = 0;
  await openBackgroundWorkConfig({
    hasUI: true,
    ui: {
      notify() {},
      select: async (_title: string, options: string[]) => visits++ === 0 ? options[4] : options[8],
    },
    async reload() { throw new Error("reload unavailable"); },
  } as any, loaded);

  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(saved.completionBehavior, "adaptive");
  assert.equal(saved.statusIndicator, false);
});
