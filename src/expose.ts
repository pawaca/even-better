import { spawn, spawnSync } from "node:child_process";
import qrcodeTerminal from "qrcode-terminal";

// Public tunnel, selected via ACCESS=<provider>. Mirrors even-terminal's
// design: each provider is a tiny spec — spawn its CLI pointed at localhost:port,
// scrape the public URL out of its output, then print the token-appended URL +
// QR. We do NOT implement any tunnel protocol ourselves.

interface Provider {
  name: string;
  program: string;
  buildArgs(port: number): string[];
  parseUrl(output: string): string | undefined;
  note?: string; // caveat printed when the provider starts
  cleanup?(): void; // synchronous teardown run on exit (in addition to killing the child)
}

const providers: Record<string, Provider> = {
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
  // Tailscale Funnel: public HTTPS at your stable ts.net name, SSE verified to
  // work. Foreground `tailscale funnel <port>` holds the tunnel while alive and
  // tears it down when killed — fits the spawn/scrape/kill model directly.
  funnel: {
    name: "funnel",
    program: "tailscale",
    buildArgs: (port) => ["funnel", String(port)],
    parseUrl: (o) => o.match(/https:\/\/[^\s/]+\.ts\.net/)?.[0]?.replace(/\/+$/, ""),
    note:
      "Tailscale Funnel: public HTTPS via your stable *.ts.net name (encrypted). " +
      "Needs Funnel enabled once in the Tailscale admin console.",
    // The funnel config lives in tailscaled and can outlive an abruptly-killed
    // child, leaving the port publicly exposed. Force it down on exit. (This
    // resets any serve config — expected, since ACCESS=funnel owns it.)
    cleanup: () => {
      try {
        spawnSync("tailscale", ["funnel", "reset"], { stdio: "ignore" });
      } catch {
        /* best effort on shutdown */
      }
    },
  },
};

export function exposeProviderNames(): string[] {
  return Object.keys(providers);
}

/**
 * Start the named tunnel and print its one QR. `buildAppUrl` turns the tunnel's
 * public base (e.g. https://x.pinggy.link) into the full app URL with the token.
 */
export function startExpose(providerName: string, port: number, buildAppUrl: (publicBase: string) => string): void {
  const provider = providers[providerName.toLowerCase()];
  if (!provider) {
    console.error(`error: unknown tunnel provider "${providerName}". Supported: ${exposeProviderNames().join(", ")}`);
    return;
  }
  const program = process.env[`${provider.name.toUpperCase()}_PROGRAM_PATH`] || provider.program;

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
    if (process.env.NO_QR !== "1") qrcodeTerminal.generate(url, { small: true }, (c) => console.log(c));
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
    provider.cleanup?.();
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
