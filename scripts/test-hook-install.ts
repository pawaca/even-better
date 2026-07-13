import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addHookEntries,
  removeHookEntries,
  installClaudeHooks,
  installCodexHooks,
  uninstallCodexHooks,
  hookHandler,
  codexHookEntry,
  shellSingleQuote,
  codexHooksFeatureEnabled,
  hooksInstalled,
  CLAUDE_EVENTS,
  CODEX_EVENTS,
  HOOK_MARKER,
} from "../src/hook-install.js";

const HANDLER = hookHandler("/home/u/.even-better/even-better-hook.sh", "claude");

// Per-event entry signatures: "command arg0 arg1…", so ours contains HOOK_MARKER
// and a third-party "other-tool" is its own signature.
function sigs(settings: Record<string, unknown>, event: string): string[] {
  const hooks = settings.hooks;
  if (typeof hooks !== "object" || hooks === null) return [];
  const arr = (hooks as Record<string, unknown>)[event];
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const block of arr) {
    if (typeof block !== "object" || block === null) continue;
    const inner = (block as { hooks?: unknown }).hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner) {
      if (typeof h !== "object" || h === null) continue;
      const e = h as { command?: unknown; args?: unknown };
      const cmd = typeof e.command === "string" ? e.command : "";
      const args = Array.isArray(e.args) ? e.args.filter((a) => typeof a === "string").join(" ") : "";
      out.push(`${cmd} ${args}`.trim());
    }
  }
  return out;
}

const ours = (ss: string[]): string[] => ss.filter((s) => s.includes(HOOK_MARKER));

test("hookHandler installs in exec form (command sh + args), async, marker in args", () => {
  assert.equal(HANDLER.command, "sh");
  assert.deepEqual(HANDLER.args, ["/home/u/.even-better/even-better-hook.sh", "claude"]);
  assert.equal(HANDLER.async, true);
  assert.equal(HANDLER.timeout, 5);
  assert.ok((HANDLER.args ?? []).some((a) => a.includes(HOOK_MARKER)));
});

test("addHookEntries adds our handler to every event without clobbering existing ones", () => {
  const before = {
    hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "other-tool" }] }] },
    permissions: { allow: [] },
  };
  const after = addHookEntries(before, HANDLER);
  const pre = sigs(after, "PreToolUse");
  assert.ok(pre.includes("other-tool")); // existing preserved
  assert.equal(ours(pre).length, 1); // ours appended
  for (const ev of CLAUDE_EVENTS) assert.equal(ours(sigs(after, ev)).length, 1, `missing on ${ev}`);
  assert.deepEqual(after.permissions, { allow: [] }); // unrelated keys untouched
});

test("addHookEntries is idempotent — re-install never duplicates our handler", () => {
  const twice = addHookEntries(addHookEntries({}, HANDLER), HANDLER);
  for (const ev of CLAUDE_EVENTS) assert.equal(ours(sigs(twice, ev)).length, 1, `duplicate on ${ev}`);
});

test("removeHookEntries strips only ours and round-trips to the original", () => {
  const original = { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "other-tool" }] }] } };
  assert.deepEqual(removeHookEntries(addHookEntries(original, HANDLER)), original);
});

test("removeHookEntries drops emptied events and the hooks key when nothing remains", () => {
  assert.equal(removeHookEntries(addHookEntries({}, HANDLER)).hooks, undefined);
});

test("removeHookEntries keeps a third-party hook coexisting in the same block", () => {
  const shared = {
    hooks: {
      PreToolUse: [
        {
          hooks: [
            { type: "command", command: "third-party" },
            HANDLER,
          ],
        },
      ],
    },
  };
  assert.deepEqual(sigs(removeHookEntries(shared), "PreToolUse"), ["third-party"]);
});

test("removeHookEntries also strips a legacy shell-form entry (marker in command)", () => {
  const legacy = {
    hooks: { Stop: [{ hooks: [{ type: "command", command: `sh "/x/${HOOK_MARKER}" claude` }] }] },
  };
  assert.equal(removeHookEntries(legacy).hooks, undefined);
});

test("installClaudeHooks refuses to overwrite a malformed settings file (no-clobber)", () => {
  const dir = mkdtempSync(join(tmpdir(), "eb-claude-"));
  const settings = join(dir, "settings.json");
  const junk = "{ not valid json ]]";
  writeFileSync(settings, junk);
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    assert.throws(() => installClaudeHooks(), /not valid JSON/);
    assert.equal(readFileSync(settings, "utf8"), junk); // left untouched
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

// ── Codex ─────────────────────────────────────────────────────────────────────

test("shellSingleQuote wraps and escapes embedded single quotes", () => {
  assert.equal(shellSingleQuote("/a/b"), "'/a/b'");
  assert.equal(shellSingleQuote("/a'b"), `'/a'\\''b'`);
});

test("codexHookEntry is a shell-string command with the marker, no async, 5s timeout", () => {
  const e = codexHookEntry("/home/u/.even-better/even-better-hook.sh");
  assert.equal(e.type, "command");
  assert.equal(e.command, "sh '/home/u/.even-better/even-better-hook.sh' codex");
  assert.ok((e.command ?? "").includes(HOOK_MARKER));
  assert.equal(e.timeout, 5);
  assert.equal(e.async, undefined); // Codex hooks.json has no async field
});

test("addHookEntries builds the Codex hooks.json shape for every codex event", () => {
  const entry = codexHookEntry("/home/u/.even-better/even-better-hook.sh");
  const doc = addHookEntries({}, entry, CODEX_EVENTS);
  for (const ev of CODEX_EVENTS) assert.equal(ours(sigs(doc, ev)).length, 1, `missing on ${ev}`);
  // block shape matches the observed codex format: { hooks: [ { command, timeout, type } ] }
  const block = (doc.hooks as Record<string, unknown>).Stop as Array<{ hooks: unknown[] }>;
  assert.equal(block[0].hooks.length, 1);
});

test("installCodexHooks writes hooks.json and uninstall round-trips, keeping others", () => {
  const dir = mkdtempSync(join(tmpdir(), "eb-codex-"));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  const hooksPath = join(dir, "hooks.json");
  // a pre-existing third-party codex hook must survive install + uninstall
  const original = { hooks: { Stop: [{ hooks: [{ type: "command", command: "cmux hooks codex stop" }] }] } };
  writeFileSync(hooksPath, JSON.stringify(original));
  try {
    installCodexHooks();
    const after = JSON.parse(readFileSync(hooksPath, "utf8")) as Record<string, unknown>;
    assert.equal(ours(sigs(after, "Stop")).length, 1); // ours added
    assert.ok(sigs(after, "Stop").includes("cmux hooks codex stop")); // third-party kept
    for (const ev of CODEX_EVENTS) assert.equal(ours(sigs(after, ev)).length, 1, `missing on ${ev}`);
    uninstallCodexHooks();
    const back = JSON.parse(readFileSync(hooksPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(back, original); // exactly the third-party hook remains
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
});

test("hooksInstalled reflects our marker in each agent's config", () => {
  const dir = mkdtempSync(join(tmpdir(), "eb-inst-"));
  const prevC = process.env.CLAUDE_CONFIG_DIR;
  const prevX = process.env.CODEX_HOME;
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude"); // installClaudeHooks mkdirs this
  process.env.CODEX_HOME = dir;
  try {
    assert.deepEqual(hooksInstalled(), { claude: false, codex: false }); // nothing yet
    installClaudeHooks();
    assert.deepEqual(hooksInstalled(), { claude: true, codex: false });
    installCodexHooks();
    assert.deepEqual(hooksInstalled(), { claude: true, codex: true });
    uninstallCodexHooks();
    assert.deepEqual(hooksInstalled(), { claude: true, codex: false });
  } finally {
    if (prevC === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevC;
    if (prevX === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevX;
  }
});

test("codexHooksFeatureEnabled detects [features] hooks = true / false / absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "eb-codexcfg-"));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  const cfg = join(dir, "config.toml");
  try {
    assert.equal(codexHooksFeatureEnabled(), null); // no config.toml
    writeFileSync(cfg, "[features]\njs_repl = false\nhooks = true\n\n[other]\nx = 1\n");
    assert.equal(codexHooksFeatureEnabled(), true);
    writeFileSync(cfg, "[other]\nhooks = true\n\n[features]\njs_repl = false\n");
    assert.equal(codexHooksFeatureEnabled(), false); // hooks=true is under [other], not [features]
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
});
