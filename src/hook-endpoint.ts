// The local unix-socket endpoint the installed hook reports to. Newline-delimited
// JSON, one connection per event (the hook connects, sends, closes). Not the public
// SSE port. See docs/HOOK-MIGRATION.md "Transport".

import { createServer, connect, type Server } from "node:net";
import { existsSync, lstatSync, mkdirSync, unlinkSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseHookReport, type HookReport } from "./hook-report.js";

/** Fixed per-user socket path. The hook honours the same `EVEN_BETTER_HOOK_SOCKET`
 *  override, so both sides stay in sync. */
export function hookSocketPath(): string {
  const override = process.env.EVEN_BETTER_HOOK_SOCKET?.trim();
  if (override) return override;
  return join(homedir(), ".even-better", "hook.sock");
}

/** True if something is currently accepting connections on the unix socket (i.e.
 *  another live even-better owns it), vs a stale file from a crashed run. */
function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    let settled = false;
    let timer: NodeJS.Timeout;
    const done = (live: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.destroy();
      resolve(live);
    };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false)); // ECONNREFUSED / ENOENT ⇒ stale
    timer = setTimeout(() => done(false), 500);
  });
}

/** Start listening for hook reports. Returns the net.Server (call `.close()` on
 *  shutdown). Malformed lines are dropped; the hook side vanishing is not an error.
 *  Rejects if a non-socket sits at the path, or if a *live* instance already owns it
 *  (so a second even-better doesn't hijack the first's hook reports). */
export async function startHookEndpoint(onReport: (r: HookReport) => void): Promise<Server> {
  const path = hookSocketPath();
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    // Only ever unlink a stale *socket* — never a regular file (a misconfigured
    // EVEN_BETTER_HOOK_SOCKET pointing at real data must not be silently deleted).
    if (!lstatSync(path).isSocket()) {
      throw new Error(
        `refusing to unlink non-socket at ${path} — set EVEN_BETTER_HOOK_SOCKET to a socket path`,
      );
    }
    // Don't hijack a socket another live instance is listening on.
    if (await socketIsLive(path)) {
      throw new Error(
        `another process is already listening on ${path} — hook reporting disabled for this instance`,
      );
    }
    try {
      unlinkSync(path); // clear a stale socket from a crashed prior run
    } catch {
      /* ignore */
    }
  }

  const server = createServer((conn) => {
    let buf = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) {
          const report = parseHookReport(line);
          if (report) onReport(report);
        }
      }
    });
    conn.on("error", () => {
      /* the hook process may exit mid-send; ignore */
    });
  });

  server.on("error", (err) => {
    console.error(`[hook-endpoint] ${(err as Error).message}`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      try {
        chmodSync(path, 0o600); // user-only, no token needed for a local socket
      } catch {
        /* best effort */
      }
      resolve();
    });
  });
  return server;
}
