/**
 * Typecheck boundary for the bundled fork. The fork's sources typecheck in
 * their own repository against their own Pi version; following the `.ts`
 * import here would drag that entire program (and its Pi type surface) into
 * this package's check. The tsconfig `paths` entry redirects the specifier to
 * this declaration for type checking only — runtime resolution is untouched.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function registerSubagentExtension(pi: ExtensionAPI): void;
