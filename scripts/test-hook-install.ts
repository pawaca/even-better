import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addClaudeHooks,
  removeClaudeHooks,
  installClaudeHooks,
  hookHandler,
  CLAUDE_EVENTS,
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

test("addClaudeHooks adds our handler to every event without clobbering existing ones", () => {
  const before = {
    hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "other-tool" }] }] },
    permissions: { allow: [] },
  };
  const after = addClaudeHooks(before, HANDLER);
  const pre = sigs(after, "PreToolUse");
  assert.ok(pre.includes("other-tool")); // existing preserved
  assert.equal(ours(pre).length, 1); // ours appended
  for (const ev of CLAUDE_EVENTS) assert.equal(ours(sigs(after, ev)).length, 1, `missing on ${ev}`);
  assert.deepEqual(after.permissions, { allow: [] }); // unrelated keys untouched
});

test("addClaudeHooks is idempotent — re-install never duplicates our handler", () => {
  const twice = addClaudeHooks(addClaudeHooks({}, HANDLER), HANDLER);
  for (const ev of CLAUDE_EVENTS) assert.equal(ours(sigs(twice, ev)).length, 1, `duplicate on ${ev}`);
});

test("removeClaudeHooks strips only ours and round-trips to the original", () => {
  const original = { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "other-tool" }] }] } };
  assert.deepEqual(removeClaudeHooks(addClaudeHooks(original, HANDLER)), original);
});

test("removeClaudeHooks drops emptied events and the hooks key when nothing remains", () => {
  assert.equal(removeClaudeHooks(addClaudeHooks({}, HANDLER)).hooks, undefined);
});

test("removeClaudeHooks keeps a third-party hook coexisting in the same block", () => {
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
  assert.deepEqual(sigs(removeClaudeHooks(shared), "PreToolUse"), ["third-party"]);
});

test("removeClaudeHooks also strips a legacy shell-form entry (marker in command)", () => {
  const legacy = {
    hooks: { Stop: [{ hooks: [{ type: "command", command: `sh "/x/${HOOK_MARKER}" claude` }] }] },
  };
  assert.equal(removeClaudeHooks(legacy).hooks, undefined);
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
