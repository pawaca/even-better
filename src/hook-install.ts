// Install/uninstall the even-better hook into the agent config. The config
// transforms are pure (unit-tested against fixtures); the fs wrappers apply them.
// Idempotent, never clobbers existing hooks, and removes only our marked entries.
// Stage 1 covers Claude (`~/.claude/settings.json`); Codex (hooks.json + trust)
// lands in a later stage. See docs/HOOK-MIGRATION.md "Install / uninstall".

import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Our command references the script by this basename, so it is identifiable for
// idempotent re-install and clean uninstall without a separate marker field.
export const HOOK_MARKER = "even-better-hook.sh";

// Claude events we install for (see the event→state map in the design doc).
export const CLAUDE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "PreToolUse",
  "PermissionRequest",
  "SubagentStop",
];

type HookEntry = { type?: string; command?: string; timeout?: number };
type HookBlock = { matcher?: string; hooks?: HookEntry[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True if a hooks block contains our command (identified by the script basename). */
function blockIsOurs(block: unknown): boolean {
  if (!isRecord(block) || !Array.isArray(block.hooks)) return false;
  return (block.hooks as HookEntry[]).some(
    (h) => typeof h?.command === "string" && h.command.includes(HOOK_MARKER),
  );
}

/** The shell command an installed hook entry runs. `sh <script> <agent>`. */
export function hookCommand(scriptPath: string, agent: "claude" | "codex"): string {
  return `sh ${JSON.stringify(scriptPath)} ${agent}`;
}

/** Add our command to each event, idempotently (drops any prior even-better block
 *  first) and without touching other tools' hooks. Pure. */
export function addClaudeHooks(
  settings: Record<string, unknown>,
  command: string,
  events: readonly string[] = CLAUDE_EVENTS,
): Record<string, unknown> {
  const hooks: Record<string, unknown> = isRecord(settings.hooks) ? { ...settings.hooks } : {};
  for (const ev of events) {
    const existing = Array.isArray(hooks[ev]) ? (hooks[ev] as unknown[]) : [];
    const cleaned = existing.filter((b) => !blockIsOurs(b));
    const block: HookBlock = { hooks: [{ type: "command", command, timeout: 5 }] };
    hooks[ev] = [...cleaned, block];
  }
  return { ...settings, hooks };
}

/** Remove our marked hook from every event; drop event arrays we emptied, and the
 *  `hooks` key if nothing remains. Leaves other tools' hooks untouched. Pure. */
export function removeClaudeHooks(settings: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(settings.hooks)) return settings;
  const hooks: Record<string, unknown> = {};
  for (const [ev, val] of Object.entries(settings.hooks)) {
    if (!Array.isArray(val)) {
      hooks[ev] = val;
      continue;
    }
    const kept = val.filter((b) => !blockIsOurs(b));
    if (kept.length > 0) hooks[ev] = kept;
  }
  const next: Record<string, unknown> = { ...settings };
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

// ── fs application ────────────────────────────────────────────────────────────

/** Where we copy the hook script so the installed command references a stable path
 *  (independent of the repo checkout location). */
export function installedScriptPath(): string {
  return join(homedir(), ".even-better", HOOK_MARKER);
}

function bundledScriptPath(): string {
  // src/hook-install.ts → ../assets/even-better-hook.sh
  return join(dirname(dirname(fileURLToPath(import.meta.url))), "assets", HOOK_MARKER);
}

function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Copy the hook script to its stable install path, executable. Returns the path. */
export function stageHookScript(): string {
  const dst = installedScriptPath();
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(bundledScriptPath(), dst);
  chmodSync(dst, 0o755);
  return dst;
}

/** Install the Claude hooks (idempotent). Returns the settings path written. */
export function installClaudeHooks(): string {
  const script = stageHookScript();
  const path = claudeSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const next = addClaudeHooks(readJson(path), hookCommand(script, "claude"));
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  return path;
}

/** Uninstall the Claude hooks (leaves other hooks intact). Returns the path or null
 *  if there was no settings file. */
export function uninstallClaudeHooks(): string | null {
  const path = claudeSettingsPath();
  if (!existsSync(path)) return null;
  const next = removeClaudeHooks(readJson(path));
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  return path;
}
