import { spawn } from "node:child_process";
import qrcodeTerminal from "qrcode-terminal";

// Optional public tunnel, selected via EXPOSE=<provider>. Mirrors
// even-terminal's design: each provider is a tiny spec — spawn its CLI pointed
// at localhost:port, scrape the public URL out of its output, then print the
// token-appended URL + QR. We do NOT implement any tunnel protocol ourselves.

interface Provider {
  name: string;
  program: string;
  buildArgs(port: number): string[];
  parseUrl(output: string): string | undefined;
  note?: string; // caveat printed when the provider starts
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
};

export function exposeProviderNames(): string[] {
  return Object.keys(providers);
}

/**
 * Start the tunnel named by EXPOSE (if any). `buildAppUrl` turns the tunnel's
 * public base (e.g. https://x.pinggy.link) into the full app URL with the token.
 */
export function startExpose(port: number, buildAppUrl: (publicBase: string) => string): void {
  const name = process.env.EXPOSE;
  if (!name) return;
  const provider = providers[name.toLowerCase()];
  if (!provider) {
    console.error(`error: unknown EXPOSE provider "${name}". Supported: ${exposeProviderNames().join(", ")}`);
    process.exit(1);
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
    console.log(`\n  Public (${provider.name}): ${base}\n`);
    console.log(`  ${url}`);
    if (process.env.NO_QR !== "1") qrcodeTerminal.generate(url, { small: true }, (c) => console.log(c));
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (err) =>
    console.error(
      `  Failed to start ${provider.name}: ${err.message} — install it, or set ${provider.name.toUpperCase()}_PROGRAM_PATH`,
    ),
  );
  child.on("exit", (code) => {
    if (code && !found) console.error(`  ${provider.name} exited with code ${code}`);
  });
  const kill = (): void => {
    if (!child.killed) child.kill();
  };
  process.on("exit", kill);
  process.on("SIGINT", () => {
    kill();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    kill();
    process.exit(0);
  });
}
