/** Conservatively classify shell commands; ambiguous composition remains mutation-risk unknown. */
export function commandRisk(command: string): "read-only" | "unknown" {
  const normalized = command.trim();
  if (!normalized || /[;&|<>`\n\r]|\$\(|\$\{/.test(normalized)) return "unknown";
  if (/^(?:pwd|ls|grep|rg|cat|head|tail|wc|sleep)(?:\s|$)/.test(normalized)) return "read-only";
  if (/^find(?:\s|$)/.test(normalized)) {
    return /(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)(?:\s|$)/.test(normalized) ? "unknown" : "read-only";
  }
  if (/^git\s+(?:status|diff|log|show)(?:\s|$)/.test(normalized)) return "read-only";
  if (/^git\s+branch(?:\s+(?:--list|--show-current|-a|-r|-v|-vv|--contains|--merged|--no-merged))*\s*$/.test(normalized)) return "read-only";
  return "unknown";
}
