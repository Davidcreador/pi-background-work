import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagentExtension from "@davecodes/pi-subagents/src/extension/index.ts";
import { registerDetachableBash } from "./bash-tool.ts";
import { registerCompletionMessageRenderer } from "./completion-message.ts";
import { loadBackgroundWorkConfig } from "./config.ts";
import backgroundWorkCoordinator from "./coordinator.ts";
import { registerSubagentResources } from "./subagent-resources.ts";

/**
 * pi-background-work — single-install background promotion for Pi.
 *
 * Composes three units behind one package:
 *   1. Coordinator — jobs, /background, /background-jobs, /background-doctor,
 *      completion delivery, cancellation, session/reload safety.
 *   2. Detachable Bash — wraps Pi's stock bash tool (config: bashTool).
 *   3. Bundled subagents — @davecodes/pi-subagents fork with top-level
 *      foreground-run promotion (config: subagents). Replaces a standalone
 *      `npm:pi-subagents` entry; remove that entry to avoid double registration.
 */
export default function piBackgroundWork(pi: ExtensionAPI): void {
  const loaded = loadBackgroundWorkConfig();
  backgroundWorkCoordinator(pi, loaded);
  registerCompletionMessageRenderer(pi);
  // The subagent tool registers regardless of `enabled` — it is a full
  // pi-subagents replacement; only promotion behavior is gated by the
  // coordinator. Bash wrapping is skipped when promotion can never trigger.
  if (loaded.config.subagents) {
    registerSubagentExtension(pi);
    registerSubagentResources(pi);
  }
  if (loaded.config.enabled && loaded.config.bashTool === "wrap") registerDetachableBash(pi);
}
