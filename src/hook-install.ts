// Install/uninstall the even-better hook into the agent config. The config
// transforms are pure (unit-tested against fixtures); the fs wrappers apply them.
// Idempotent, never clobbers existing hooks, and removes only our marked entries.
// Claude → `~/.claude/settings.json`; Codex → `$CODEX_HOME/hooks.json` (+ the user
// trusts it via `/hooks`). See docs/HOOK-MIGRATION.md "Install / uninstall".

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
 *  first) and without touching other tools' hooks. Pure. Structure-generic: the same
 *  `{ hooks: { <Event>: [ { hooks: [entry] } ] } }` shape backs both Claude's
 *  `settings.json` and Codex's `hooks.json`, so this drives both installs. */
export function addHookEntries(
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
 *  `hooks` key if nothing remains. Leaves other tools' hooks untouched. Pure. Drives
 *  both the Claude and Codex uninstall (shared shape — see addHookEntries). */
export function removeHookEntries(settings: Record<string, unknown>): Record<string, unknown> {
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
  const next = addHookEntries(current, hookHandler(script, "claude"));
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  return path;
}

/** Uninstall the Claude hooks (leaves other hooks intact). Returns the path or null
 *  if there was no settings file. */
export function uninstallClaudeHooks(): string | null {
  const path = claudeSettingsPath();
  if (!existsSync(path)) return null;
  const next = removeHookEntries(readJson(path));
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  return path;
}

// ── Codex (hooks.json + trust) ──────────────────────────────────────────────────
// Codex reads hooks from `$CODEX_HOME/hooks.json` (same nested shape as Claude), but
// it SKIPS a non-managed command hook until the user trusts the exact definition via
// the `/hooks` TUI (a `[hooks.state].trusted_hash` in config.toml). We install +
// enable the feature and guide the user through `/hooks`; we do NOT forge the trust
// hash (codex-internal, version-fragile). See docs/HOOK-MIGRATION.md.

// Codex lifecycle events we consume (PascalCase, per hooks.json). No StopFailure
// (Codex has none); PostToolUse/compaction carry no status so we skip them.
export const CODEX_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "PreToolUse",
  "PermissionRequest",
  "SubagentStart",
  "SubagentStop",
];

/** POSIX single-quote a string so a path with shell metacharacters can't expand when
 *  Codex runs the command through the shell (Codex hooks are a command STRING, not the
 *  exec form Claude accepts). */
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The Codex hook entry: a shell-string command (the script reads the payload on stdin
 *  and takes the agent as $1). Synchronous within the 5s timeout — the send is a fast
 *  local socket write. Identifiable by the script basename (HOOK_MARKER) for uninstall. */
export function codexHookEntry(scriptPath: string): HookEntry {
  return { type: "command", command: `sh ${shellSingleQuote(scriptPath)} codex`, timeout: 5 };
}

function codexHome(): string {
  const raw = process.env.CODEX_HOME?.trim();
  return raw ? raw : join(homedir(), ".codex");
}

function codexHooksPath(): string {
  return join(codexHome(), "hooks.json");
}

function codexConfigPath(): string {
  return join(codexHome(), "config.toml");
}

/** Best-effort read-only check of `[features] hooks = true` in config.toml. Returns
 *  true/false, or null when config.toml is absent. Codex won't load hooks.json unless
 *  the feature is on, so the install guidance tells the user to enable it when off. */
export function codexHooksFeatureEnabled(): boolean | null {
  const path = codexConfigPath();
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  // Scan the [features] table for `hooks = true` before the next table header.
  const lines = text.split("\n");
  let inFeatures = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (/^\[[^\]]+\]/.test(line)) inFeatures = /^\[features\]/.test(line);
    else if (inFeatures && /^hooks\s*=\s*true\b/.test(line)) return true;
  }
  return false;
}

/** Install the Codex hooks into `$CODEX_HOME/hooks.json` (idempotent, additive).
 *  Returns the path written. Trust + the feature flag are the user's step via `/hooks`. */
export function installCodexHooks(): string {
  const path = codexHooksPath();
  const current = readJson(path); // throws on a malformed existing file — abort before any write
  const script = stageHookScript();
  mkdirSync(dirname(path), { recursive: true });
  const next = addHookEntries(current, codexHookEntry(script), CODEX_EVENTS);
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  return path;
}

/** Uninstall the Codex hooks (leaves other tools' entries intact). Returns the path,
 *  or null if there was no hooks.json. */
export function uninstallCodexHooks(): string | null {
  const path = codexHooksPath();
  if (!existsSync(path)) return null;
  const next = removeHookEntries(readJson(path));
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  return path;
}
