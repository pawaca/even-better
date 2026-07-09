import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHookEndpoint } from "../src/hook-endpoint.js";

function withSocketEnv<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.EVEN_BETTER_HOOK_SOCKET;
  process.env.EVEN_BETTER_HOOK_SOCKET = path;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.EVEN_BETTER_HOOK_SOCKET;
    else process.env.EVEN_BETTER_HOOK_SOCKET = prev;
  });
}

test("startHookEndpoint refuses to unlink a non-socket at the socket path", async () => {
  const p = join(mkdtempSync(join(tmpdir(), "eb-ep-")), "not-a-socket");
  writeFileSync(p, "important user data");
  await withSocketEnv(p, async () => {
    await assert.rejects(startHookEndpoint(() => {}), /non-socket/);
    assert.ok(existsSync(p));
    assert.equal(readFileSync(p, "utf8"), "important user data"); // left untouched
  });
});

test("startHookEndpoint refuses to hijack a socket a live instance owns", async () => {
  const p = join(mkdtempSync(join(tmpdir(), "eb-ep-")), "h.sock");
  await withSocketEnv(p, async () => {
    const first = await startHookEndpoint(() => {}); // resolves once bound
    try {
      await assert.rejects(startHookEndpoint(() => {}), /already listening/);
    } finally {
      first.close();
    }
  });
});
