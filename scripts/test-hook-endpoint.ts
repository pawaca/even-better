import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHookEndpoint } from "../src/hook-endpoint.js";

test("startHookEndpoint refuses to unlink a non-socket at the socket path", () => {
  const dir = mkdtempSync(join(tmpdir(), "eb-ep-"));
  const p = join(dir, "not-a-socket");
  writeFileSync(p, "important user data");
  const prev = process.env.EVEN_BETTER_HOOK_SOCKET;
  process.env.EVEN_BETTER_HOOK_SOCKET = p;
  try {
    assert.throws(() => startHookEndpoint(() => {}), /non-socket/);
    assert.ok(existsSync(p));
    assert.equal(readFileSync(p, "utf8"), "important user data"); // left untouched
  } finally {
    if (prev === undefined) delete process.env.EVEN_BETTER_HOOK_SOCKET;
    else process.env.EVEN_BETTER_HOOK_SOCKET = prev;
  }
});
