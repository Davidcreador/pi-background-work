import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);

/**
 * Resolve a resource directory shipped inside the bundled fork.
 *
 * Static `pi.skills`/`pi.prompts` package.json paths cannot work here: npm
 * hoists dependencies, so `./node_modules/@davecodes/pi-subagents/...` only
 * exists in un-hoisted layouts. Runtime resolution through the module system
 * finds the fork wherever npm actually placed it (hoisted, nested, or a
 * workspace/file: symlink during development).
 */
function forkResourceDir(kind: "skills" | "prompts"): string | undefined {
  try {
    const packageJson = require.resolve("@davecodes/pi-subagents/package.json");
    const dir = path.join(path.dirname(packageJson), kind);
    return fs.existsSync(dir) ? dir : undefined;
  } catch {
    // Fork not installed (or exports-restricted): skills/prompts are additive,
    // never fail extension load over them.
    return undefined;
  }
}

/** Contribute the bundled fork's skills and prompts via resources_discover. */
export function registerSubagentResources(pi: ExtensionAPI): void {
  pi.on("resources_discover", () => {
    const skills = forkResourceDir("skills");
    const prompts = forkResourceDir("prompts");
    return {
      ...(skills ? { skillPaths: [skills] } : {}),
      ...(prompts ? { promptPaths: [prompts] } : {}),
    };
  });
}
