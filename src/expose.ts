import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import qrcodeTerminal from "qrcode-terminal";

// Public access, selected via PUBLIC_ACCESS=<provider>. Most providers are tiny specs:
// spawn their CLI pointed at localhost:port, scrape the public URL, then print
// the token-appended URL + QR. Tailscale Funnel needs special handling because
// its config is global per node and must be cleaned up by exact slot/path, not
// by `reset`, so multiple bridge instances can coexist.

interface Provider {
  name: string;
  program: string;
  buildArgs(port: number): string[];
  parseUrl(output: string): string | undefined;
  note?: string; // caveat printed when the provider starts
}

export interface ExposeOptions {
  fallbackPath?: string;
  instanceId?: string;
  qrEnabled?: boolean;
}

const genericProviders: Record<string, Provider> = {
  // Zero-install: uses the system ssh for a reverse tunnel. SSE works.
  pinggy: {
    name: "pinggy",
    program: "ssh",
    buildArgs: (port) => ["-o", "StrictHostKeyChecking=no", "-p", "443", `-R0:localhost:${port}`, "a.pinggy.io"],
    parseUrl: (o) =>
      o.match(/https:\/\/[^\s]+\.pinggy(?:-free)?\.link/)?.[0] ??
      o.match(/http:\/\/[^\s]+\.pinggy(?:-free)?\.link/)?.[0],
    note: "Free pinggy tunnels last 60 min, then the URL changes.",
  },
  bore: {
    name: "bore",
    program: "bore",
    buildArgs: (port) => ["local", String(port), "--to", "bore.pub"],
    parseUrl: (o) => {
      const m = o.match(/\blistening at\s+bore\.pub:(\d+)\b/i);
      return m ? `http://bore.pub:${m[1]}` : undefined;
    },
    note: "bore is plain HTTP (no TLS) — the token travels in the clear. Prefer pinggy/Tailscale.",
  },
  ngrok: {
    name: "ngrok",
    program: "ngrok",
    buildArgs: (port) => ["http", String(port), "--log=stdout", "--log-format=json"],
    parseUrl: (o) => {
      for (const line of o.split(/\r?\n/)) {
        try {
          const e = JSON.parse(line.trim()) as { url?: unknown };
          if (typeof e.url === "string" && /^https?:\/\/[^/]+\.ngrok/.test(e.url)) return e.url;
        } catch {
          /* not a json line */
        }
      }
      return undefined;
    },
    note: "ngrok needs a free account + authtoken (ngrok config add-authtoken <TOKEN>).",
  },
  cloudflared: {
    name: "cloudflared",
    program: "cloudflared",
    buildArgs: (port) => ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"],
    parseUrl: (o) => o.match(/https:\/\/[^\s]+\.trycloudflare\.com/)?.[0],
    note:
      "⚠ Cloudflare QUICK tunnels do NOT support Server-Sent Events, which this " +
      "bridge streams over — expect no live output. For Cloudflare use a NAMED " +
      "tunnel pointed at localhost:<port> (SSE works, and you can add Access auth); see README.",
  },
};

export function exposeProviderNames(): string[] {
  return ["funnel", ...Object.keys(genericProviders)];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const FUNNEL_PORTS = [443, 8443, 10000] as const;
const FUNNEL_LOCK_DIR = join(tmpdir(), "even-better-tailscale-funnel.lock");
const FUNNEL_LOCK_OWNER_FILE = join(FUNNEL_LOCK_DIR, "owner");
const FUNNEL_LOCK_WAIT_MS = 20_000;
const FUNNEL_LOCK_STALE_MS = 60_000;

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string"
    ? (err as { code: string }).code
    : undefined;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === "EPERM";
  }
}

function isStaleFunnelLock(): boolean {
  try {
    const pid = Number(readFileSync(FUNNEL_LOCK_OWNER_FILE, "utf8").split(":")[0]);
    if (Number.isInteger(pid) && pid > 0) return !isProcessAlive(pid);
  } catch (err) {
    if (errorCode(err) !== "ENOENT") return false;
  }

  try {
    return Date.now() - statSync(FUNNEL_LOCK_DIR).mtimeMs > FUNNEL_LOCK_STALE_MS;
  } catch (err) {
    return errorCode(err) === "ENOENT";
  }
}

function acquireFunnelLock(): (() => void) | undefined {
  const owner = `${process.pid}:${Date.now()}`;
  const deadline = Date.now() + FUNNEL_LOCK_WAIT_MS;

  while (true) {
    try {
      mkdirSync(FUNNEL_LOCK_DIR);
      try {
        writeFileSync(FUNNEL_LOCK_OWNER_FILE, `${owner}\n`);
      } catch (err) {
        rmSync(FUNNEL_LOCK_DIR, { recursive: true, force: true });
        console.error(`error: unable to write Tailscale Funnel lock owner: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
      return () => {
        try {
          if (readFileSync(FUNNEL_LOCK_OWNER_FILE, "utf8").trim() === owner) rmSync(FUNNEL_LOCK_DIR, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      };
    } catch (err) {
      if (errorCode(err) !== "EEXIST") {
        console.error(`error: unable to acquire Tailscale Funnel lock: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
      if (isStaleFunnelLock()) {
        try {
          rmSync(FUNNEL_LOCK_DIR, { recursive: true, force: true });
        } catch (removeErr) {
          if (errorCode(removeErr) !== "ENOENT") {
            console.error(
              `error: unable to clear stale Tailscale Funnel lock: ${removeErr instanceof Error ? removeErr.message : String(removeErr)}`,
            );
            return undefined;
          }
        }
        continue;
      }
      if (Date.now() >= deadline) {
        console.error("error: timed out waiting for Tailscale Funnel slot lock; another instance may still be configuring Funnel.");
        return undefined;
      }
      sleepSync(100);
    }
  }
}

function statusJson(program: string, command: "serve" | "funnel"): unknown {
  const r = spawnSync(program, [command, "status", "--json"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return undefined;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return undefined;
  }
}

function collectTcpPorts(v: unknown, out = new Set<number>()): Set<number> {
  if (!isRecord(v)) return out;
  const tcp = v.TCP;
  if (isRecord(tcp)) {
    for (const key of Object.keys(tcp)) {
      const port = Number(key);
      if (Number.isInteger(port)) out.add(port);
    }
  }
  for (const child of Object.values(v)) collectTcpPorts(child, out);
  return out;
}

function portFromWebKey(key: string): number | undefined {
  const m = key.match(/:(\d+)$/);
  if (!m) return undefined;
  const port = Number(m[1]);
  return Number.isInteger(port) ? port : undefined;
}

export function collectWebPorts(v: unknown, out = new Set<number>()): Set<number> {
  if (!isRecord(v)) return out;
  const web = v.Web;
  if (isRecord(web)) {
    for (const [key, value] of Object.entries(web)) {
      if (!isRecord(value) || !isRecord(value.Handlers) || Object.keys(value.Handlers).length === 0) continue;
      const port = portFromWebKey(key);
      if (port !== undefined) out.add(port);
    }
  }
  for (const child of Object.values(v)) collectWebPorts(child, out);
  return out;
}

function chooseFunnelSlot(program: string): number | undefined {
  const used = new Set<number>([
    ...collectTcpPorts(statusJson(program, "funnel")),
    ...collectTcpPorts(statusJson(program, "serve")),
  ]);
  return FUNNEL_PORTS.find((port) => !used.has(port));
}

function chooseFunnelPathPort(program: string): number | undefined {
  const funnelPorts = collectWebPorts(statusJson(program, "funnel"));
  return FUNNEL_PORTS.find((port) => funnelPorts.has(port));
}

function waitForFunnelPort(program: string, publicPort: number): void {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (collectWebPorts(statusJson(program, "funnel")).has(publicPort)) return;
    sleepSync(100);
  }
}

export function normalizeFunnelPath(raw: string): string {
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, "");
  return withoutTrailingSlash ? `${withoutTrailingSlash}/` : "/";
}

function pathForFunnel(options: ExposeOptions): string {
  return normalizeFunnelPath(options.fallbackPath ?? `/eb/${options.instanceId ?? process.pid}`);
}

function parseTailscaleBase(output: string, publicPort: number): string | undefined {
  const raw = output.match(/https:\/\/[^\s/]+\.ts\.net(?::\d+)?/)?.[0];
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (publicPort !== 443 && !u.port) u.port = String(publicPort);
    return u.origin;
  } catch {
    return undefined;
  }
}

export function withPath(base: string, basePath: string): string {
  if (!basePath || basePath === "/") return base;
  const u = new URL(base);
  u.pathname = basePath;
  return u.toString();
}

/**
 * Start the named public-access provider and print its one QR. `buildAppUrl` turns the provider's
 * public base (e.g. https://x.pinggy.link) into the full app URL with the token.
 */
export function startExpose(
  providerName: string,
  port: number,
  buildAppUrl: (publicBase: string) => string,
  options: ExposeOptions = {},
): void {
  if (providerName.toLowerCase() === "funnel") {
    startTailscaleFunnel(port, buildAppUrl, options);
    return;
  }
  const provider = genericProviders[providerName.toLowerCase()];
  if (!provider) {
    console.error(`error: unknown tunnel provider "${providerName}". Supported: ${exposeProviderNames().join(", ")}`);
    return;
  }
  const program = provider.program;

  console.log(`\n  Starting public tunnel via ${provider.name}...`);
  if (provider.note) console.log(`  ${provider.note}`);

  const child = spawn(program, provider.buildArgs(port), { stdio: ["ignore", "pipe", "pipe"] });
  let found = false;
  let buffer = "";
  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString();
    if (found) return;
    const base = provider.parseUrl(buffer);
    if (!base) return;
    found = true;
    const url = buildAppUrl(base);
    console.log(`\n  Public (${provider.name}): ${base}`);
    console.log(`  Scan to connect · ${url}`);
    if (options.qrEnabled !== false) qrcodeTerminal.generate(url, { small: true }, (c) => console.log(c));
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  // If no URL appears in time, the provider is likely stuck (e.g. Funnel not
  // enabled, ssh key prompt) — surface what it printed so the failure is visible.
  const timeout = setTimeout(() => {
    if (!found) console.error(`  ${provider.name}: no public URL after 15s. Output so far:\n${buffer.trim() || "(none)"}`);
  }, 15_000);
  timeout.unref?.();
  child.on("error", (err) =>
    console.error(
      `  Failed to start ${provider.name}: ${err.message} — install it, or set ${provider.name.toUpperCase()}_PROGRAM_PATH`,
    ),
  );
  child.on("exit", (code) => {
    if (code && !found) console.error(`  ${provider.name} exited with code ${code}`);
  });
  // Tear down on exit. The "exit" handler is the reliable path — the server's
  // own SIGINT/SIGTERM handlers call process.exit() first, which pre-empts any
  // signal handler registered here but still fires "exit".
  const teardown = (): void => {
    if (!child.killed) child.kill();
  };
  process.on("exit", teardown);
  process.on("SIGINT", () => {
    teardown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    teardown();
    process.exit(0);
  });
}

function startTailscaleFunnel(port: number, buildAppUrl: (publicBase: string) => string, options: ExposeOptions): void {
  const program = "tailscale";
  let releaseSlotLock: (() => void) | undefined = acquireFunnelLock();
  if (!releaseSlotLock) return;
  const releaseFunnelSlotLock = (): void => {
    if (!releaseSlotLock) return;
    releaseSlotLock();
    releaseSlotLock = undefined;
  };

  let publicPort = chooseFunnelSlot(program);
  let basePath = "";
  if (!publicPort) {
    publicPort = chooseFunnelPathPort(program);
    basePath = publicPort ? pathForFunnel(options) : "";
    if (publicPort) {
      console.warn(
        `  No free Tailscale Funnel public port; sharing ${publicPort} at ${basePath}. ` +
          "Verify the app preserves the scanned URL path as its API base.",
      );
    }
  }
  if (!publicPort) {
    releaseFunnelSlotLock();
    console.error(`error: no free Tailscale Funnel public port and no existing Funnel port to share. Available ports are ${FUNNEL_PORTS.join(", ")}.`);
    return;
  }
  const args = ["funnel", `--https=${publicPort}`, "--yes"];
  if (basePath) args.push(`--set-path=${basePath}`);
  args.push(`http://127.0.0.1:${port}`);

  console.log(`\n  Starting public tunnel via Tailscale Funnel...`);
  console.log(`  Tailscale Funnel: public HTTPS via your stable *.ts.net name (encrypted).`);
  console.log(`  Public slot: ${publicPort}${basePath ? ` path=${basePath}` : ""}`);

  const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
  let found = false;
  let buffer = "";
  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString();
    if (found) return;
    const origin = parseTailscaleBase(buffer, publicPort);
    if (!origin) return;
    found = true;
    waitForFunnelPort(program, publicPort);
    releaseFunnelSlotLock();
    const base = basePath ? withPath(origin, basePath) : origin;
    const url = buildAppUrl(base);
    console.log(`\n  Public (funnel): ${base}`);
    console.log(`  Scan to connect · ${url}`);
    if (options.qrEnabled !== false) qrcodeTerminal.generate(url, { small: true }, (c) => console.log(c));
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const timeout = setTimeout(() => {
    if (!found) {
      console.error(`  funnel: no public URL after 15s. Output so far:\n${buffer.trim() || "(none)"}`);
    }
  }, 15_000);
  timeout.unref?.();

  child.on("error", (err) => {
    releaseFunnelSlotLock();
    console.error(`  Failed to start funnel: ${err.message} — install tailscale and make sure it is on PATH`);
  });
  child.on("exit", (code) => {
    releaseFunnelSlotLock();
    if (code && !found) console.error(`  funnel exited with code ${code}`);
  });

  let cleaned = false;
  const teardown = (): void => {
    if (cleaned) return;
    cleaned = true;
    releaseFunnelSlotLock();
    if (!child.killed) child.kill();
    const off = ["funnel", `--https=${publicPort}`, "--yes"];
    if (basePath) off.push(`--set-path=${basePath}`);
    off.push("off");
    try {
      spawnSync(program, off, { stdio: "ignore" });
    } catch {
      /* best effort on shutdown */
    }
  };
  process.on("exit", teardown);
  process.on("SIGINT", () => {
    teardown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    teardown();
    process.exit(0);
  });
}
