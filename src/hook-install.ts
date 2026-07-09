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

export type HookEntry = {
  type?: string;
  command?: string;
  args?: string[];
  timeout?: number;
  async?: boolean;
};
type HookBlock = { matcher?: string; hooks?: HookEntry[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True if a hook entry is ours — identified by the script basename in its args
 *  (exec form) or command string (legacy shell form). */
function entryIsOurs(h: unknown): boolean {
  if (!isRecord(h)) return false;
  const inArgs =
    Array.isArray(h.args) && h.args.some((a) => typeof a === "string" && a.includes(HOOK_MARKER));
  const inCmd = typeof h.command === "string" && h.command.includes(HOOK_MARKER);
  return inArgs || inCmd;
}

/** Remove our hook *entries* from one block. Returns the block with the remaining
 *  hooks, or null if it held only ours (drop it). A coexisting third-party hook in
 *  the same block is preserved — we never delete a whole block for other tools. */
function stripOurEntries(block: unknown): unknown | null {
  if (!isRecord(block) || !Array.isArray(block.hooks)) return block;
  const entries = block.hooks as HookEntry[];
  const kept = entries.filter((h) => !entryIsOurs(h));
  if (kept.length === entries.length) return block; // nothing of ours here
  if (kept.length === 0) return null; // block held only ours
  return { ...block, hooks: kept };
}

/** The installed hook handler, in **exec form** (`command: "sh"` + `args`): Claude
 *  runs command-only hooks through `sh -c`, where a script path containing shell
 *  metacharacters ($(), backticks — e.g. from a nonstandard $HOME) would expand;
 *  exec form passes the path literally. async so the turn never waits on the socket. */
export function hookHandler(scriptPath: string, agent: "claude" | "codex"): HookEntry {
  return { type: "command", command: "sh", args: [scriptPath, agent], timeout: 5, async: true };
}

/** Add our command to each event, idempotently (drops any prior even-better block
 *  first) and without touching other tools' hooks. Pure. */
export function addClaudeHooks(
  settings: Record<string, unknown>,
  handler: HookEntry,
  events: readonly string[] = CLAUDE_EVENTS,
): Record<string, unknown> {
  const hooks: Record<string, unknown> = isRecord(settings.hooks) ? { ...settings.hooks } : {};
  for (const ev of events) {
    const existing = Array.isArray(hooks[ev]) ? (hooks[ev] as unknown[]) : [];
    const cleaned = existing.map(stripOurEntries).filter((b) => b !== null);
    const block: HookBlock = { hooks: [handler] };
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
    const kept = val.map(stripOurEntries).filter((b) => b !== null);
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
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  return join(dir, "settings.json");
}

/** Read existing settings. `{}` when the file is absent (fresh install). **Throws**
 *  when it exists but is unreadable / not valid JSON / not an object — callers must
 *  NOT then write, or they'd clobber the user's real settings (no-clobber). */
function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} exists but is not valid JSON — refusing to overwrite it`);
  }
  if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object — refusing to overwrite it`);
  return parsed;
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
  const path = claudeSettingsPath();
  const current = readJson(path); // throws on a malformed existing file — abort before any write
  const script = stageHookScript();
  mkdirSync(dirname(path), { recursive: true });
  const next = addClaudeHooks(current, hookHandler(script, "claude"));
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
