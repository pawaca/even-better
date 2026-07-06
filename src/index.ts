import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import path from "node:path";
import readline from "node:readline";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import cors from "cors";
import qrcodeTerminal from "qrcode-terminal";
import {
  disposeAll,
  focusedOrFirstBridge,
  getBridge,
  getOrCreateBridge,
  refreshAgents,
} from "./bridge.js";
import { emit, getMessages, sseHandler } from "./sse.js";
import { getMux, setMux, type Multiplexer } from "./multiplexer.js";
import { HerdrMultiplexer, herdrAvailable } from "./herdr.js";
import { CmuxMultiplexer, cmuxAvailable } from "./cmux.js";
import { logEvent, eventLogPath } from "./log.js";
import { extractModel } from "./parse.js";
import { startExpose, exposeProviderNames } from "./expose.js";

const VERSION = "0.1.0";
const PORT = parseInt(process.env.PORT ?? "3456", 10);

// Pick the multiplexer once, before anything touches it. MUX=cmux|herdr forces
// it. Otherwise: use whichever backend is present; if BOTH are, never guess —
// prompt on a TTY, and fail fast without one (so nothing silently mirrors the
// wrong terminal). A missing backend surfaces later as NOT REACHABLE.
type MuxChoice = { name: string; make: () => Multiplexer };

function promptMux(found: MuxChoice[]): Promise<Multiplexer> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const list = found.map((f, i) => `  ${i + 1}) ${f.name}`).join("\n");
  return new Promise((resolve) => {
    rl.question(`\nMultiple multiplexers detected. Choose one:\n${list}\n> `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      const chosen = found[Number(a) - 1] ?? found.find((f) => f.name === a) ?? found[0];
      resolve(chosen.make());
    });
  });
}

async function selectMux(): Promise<Multiplexer> {
  const pick = (process.env.MUX ?? "").toLowerCase();
  if (pick === "herdr") return new HerdrMultiplexer();
  if (pick === "cmux") return new CmuxMultiplexer();
  if (pick) {
    console.error(`error: unknown MUX "${pick}". Use: herdr, cmux.`);
    return process.exit(1);
  }
  const found: MuxChoice[] = [];
  if (herdrAvailable()) found.push({ name: "herdr", make: () => new HerdrMultiplexer() });
  if (cmuxAvailable()) found.push({ name: "cmux", make: () => new CmuxMultiplexer() });
  if (found.length <= 1) return (found[0]?.make ?? (() => new HerdrMultiplexer()))();
  if (!process.stdin.isTTY) {
    const names = found.map((f) => f.name);
    console.error(
      `error: multiple multiplexers detected (${names.join(", ")}) and no TTY to prompt. ` +
        `Set MUX=${names.join("|")} to choose.`,
    );
    return process.exit(1);
  }
  return promptMux(found);
}

setMux(await selectMux());

// The bearer token. Priority: BRIDGE_TOKEN env → a token persisted under
// ~/.config/even-better/token (generated once, reused across restarts so you
// scan the QR once; rotate by deleting the file) → an ephemeral one.
function resolveToken(): string {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  const file = path.join(homedir(), ".config", "even-better", "token");
  try {
    if (existsSync(file)) {
      const t = readFileSync(file, "utf8").trim();
      if (t) return t;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    const t = randomBytes(24).toString("hex");
    writeFileSync(file, t + "\n", { mode: 0o600 });
    return t;
  } catch {
    return randomBytes(24).toString("hex");
  }
}
const TOKEN = resolveToken();
const defaultProviderPinned = process.env.DEFAULT_PROVIDER !== undefined;
let defaultProvider = process.env.DEFAULT_PROVIDER ?? "claude";

function providerForAgent(agent: string | undefined): "codex" | "claude" {
  return agent === "codex" ? "codex" : "claude";
}

/** Constant-time token check (avoids leaking the token via comparison timing). */
function tokenMatches(provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

function auth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const queryToken = req.query.token as string | undefined;
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : queryToken;
  if (!tokenMatches(provided)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

const api = express.Router();
app.use("/api", auth, api);

// Log every inbound app request (except the SSE stream itself) for debugging.
api.use((req, _res, next) => {
  if (req.path !== "/events") {
    const sessionId =
      (req.body?.sessionId as string) ??
      (req.query.sessionId as string) ??
      "";
    logEvent("in", sessionId, {
      method: req.method,
      path: req.path,
      ...(req.method === "POST" ? { body: req.body } : { query: req.query }),
    });
  }
  next();
});

// ── even-terminal protocol surface ─────────────────────

api.get("/events", (req, res) => {
  sseHandler(req, res);
  // Push a status snapshot to the fresh client so it knows immediately
  // whether a turn is running. Without this, an app that connects while the
  // agent is idle waits forever for a status/result that never comes (status
  // events are only emitted on transitions).
  const sessionId = req.query.sessionId as string | undefined;
  if (sessionId) {
    const bridge = getBridge(sessionId);
    if (bridge) {
      emit(sessionId, {
        type: "status",
        state: bridge.state,
        sessionId,
      });
    }
  }
});

api.get("/sessions", async (_req, res) => {
  try {
    const agents = await refreshAgents();
    const sessions = agents.map((a) => ({
      id: a.paneId,
      title: `${a.agent} · ${path.basename(a.cwd || "/")}`,
      timestamp: new Date().toISOString(),
      cwd: a.cwd,
      provider: providerForAgent(a.agent),
      status: getBridge(a.paneId)?.state ?? "idle",
    }));
    res.json({ sessions });
  } catch (err) {
    res.json({ sessions: [], error: (err as Error).message });
  }
});

api.get("/info", async (_req, res) => {
  let model = "";
  let provider: "codex" | "claude" = "claude";
  try {
    const agents = await refreshAgents();
    const target = agents.find((a) => a.focused) ?? agents[0];
    provider = providerForAgent(target?.agent);
    if (target?.agent === "claude") {
      const text = await getMux().read(target.paneId, 5);
      model = extractModel(text);
    }
  } catch {
    // leave model unknown
  }
  res.json({
    account: {},
    model: model || "Unknown",
    version: `${VERSION} (even-better)`,
    provider,
  });
});

api.get("/update-check", (_req, res) => {
  res.json({
    currentVersion: VERSION,
    newestVersion: null,
    updateAvailable: false,
  });
});

api.post("/prompt", async (req, res) => {
  const { text, sessionId } = (req.body ?? {}) as {
    text?: string;
    sessionId?: string;
  };
  if (!text || typeof text !== "string") {
    res.status(400).json({ error: "Missing 'text' field" });
    return;
  }
  try {
    let bridge = sessionId ? await getOrCreateBridge(sessionId) : undefined;
    if (!bridge) {
      const agents = await refreshAgents();
      bridge = focusedOrFirstBridge(agents);
    }
    if (!bridge) {
      res.status(404).json({ error: "No agent pane found" });
      return;
    }
    console.log(`[prompt] pane=${bridge.paneId} text=${text.slice(0, 80)}`);
    await bridge.prompt(text);
    res.status(202).json({ ok: true, sessionId: bridge.paneId, provider: bridge.provider });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

api.post("/permission-response", async (req, res) => {
  const { sessionId, decision } = (req.body ?? {}) as {
    sessionId?: string;
    decision?: string;
  };
  if (!sessionId) {
    res.status(400).json({ error: "Missing 'sessionId'" });
    return;
  }
  const bridge = getBridge(sessionId);
  if (!bridge) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await bridge.respondPermission(decision || "deny");
  res.json({ ok: true });
});

api.post("/question-response", async (req, res) => {
  const { sessionId, answer } = (req.body ?? {}) as {
    sessionId?: string;
    answer?: string;
  };
  if (!sessionId) {
    res.status(400).json({ error: "Missing 'sessionId'" });
    return;
  }
  const bridge = getBridge(sessionId);
  if (!bridge) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await bridge.respondQuestion(answer || "skip");
  res.json({ ok: true });
});

api.post("/interrupt", async (req, res) => {
  const { sessionId } = (req.body ?? {}) as { sessionId?: string };
  if (!sessionId) {
    res.status(400).json({ error: "Missing 'sessionId'" });
    return;
  }
  const bridge = getBridge(sessionId);
  if (!bridge) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await bridge.interrupt();
  res.json({ ok: true });
});

api.get("/status", (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  if (!sessionId) {
    res.status(400).json({ error: "Missing 'sessionId'" });
    return;
  }
  const bridge = getBridge(sessionId);
  if (!bridge) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json({ state: bridge.state, sessionId, provider: bridge.provider });
});

api.get("/messages", (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  const after = parseInt((req.query.after as string) ?? "0", 10) || 0;
  if (!sessionId) {
    res.status(400).json({ error: "Missing 'sessionId'" });
    return;
  }
  const bridge = getBridge(sessionId);
  res.json({
    messages: getMessages(sessionId, after),
    state: bridge?.state ?? "idle",
    sessionId,
    provider: bridge?.provider ?? null,
  });
});

api.get("/sessions/:id/history", (_req, res) => {
  res.json({ history: [] });
});

// ── startup ────────────────────────────────────────────

// An IPv4 in 100.64.0.0/10 is Tailscale's CGNAT range — reachable from any
// device on the same tailnet, so the app can connect over it off-Wi-Fi.
function isTailscale(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

function ipv4s(): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

const lanAddress = (): string | undefined => ipv4s().find((ip) => !isTailscale(ip));
const tailscaleAddress = (): string | undefined => ipv4s().find(isTailscale);

const authQuery = (): string => `token=${TOKEN}&defaultProvider=${encodeURIComponent(defaultProvider)}`;
const urlFor = (host: string): string => `http://${host}:${PORT}?${authQuery()}`;
// A tunnel gives a full public base (scheme+host); just append the auth query.
const appUrlFromBase = (base: string): string => `${base}?${authQuery()}`;

// ── access: one knob, one QR ───────────────────────────
// ACCESS answers a single question — "how does the phone reach the bridge?" —
// and drives BOTH the listen bind and the one QR we print, so there is nothing
// to choose between at scan time. Modes:
//   lan       (default) bind all interfaces, QR = LAN IP     — same Wi-Fi
//   local               bind loopback,       QR = localhost  — same machine
//   tailscale           bind tailnet IP,     QR = tailnet IP — private, off-Wi-Fi
//   tailscale-funnel|pinggy|…  bind loopback + run a public tunnel, QR = its URL
//   <literal ip>        bind that IP,        QR = that IP
interface Access {
  label: string;
  bindHost: string;
  qrHost?: string; // non-tunnel modes: host to encode in the QR (undefined ⇒ offline fallback)
  tunnel?: string; // tunnel modes: provider to spawn (the QR comes from the tunnel URL)
}

function resolveAccess(): Access {
  const a = (process.env.ACCESS || "lan").toLowerCase();
  if (a === "lan") return { label: "LAN (same Wi-Fi)", bindHost: "0.0.0.0", qrHost: lanAddress() };
  if (a === "local" || a === "localhost")
    return { label: "local only (same machine)", bindHost: "127.0.0.1", qrHost: "localhost" };
  if (a === "tailscale") {
    const ts = tailscaleAddress();
    if (!ts) {
      console.error("ACCESS=tailscale but no Tailscale (100.64/10) address found — is Tailscale up?");
      process.exit(1);
    }
    return { label: "Tailscale (private tailnet)", bindHost: ts, qrHost: ts };
  }
  // "tailscale-funnel" is the canonical name (makes the Tailscale relationship
  // visible next to ACCESS=tailscale); "funnel" is accepted as shorthand since
  // it matches the CLI verb.
  if (a === "tailscale-funnel" || a === "funnel")
    return { label: "Tailscale Funnel (public HTTPS)", bindHost: "127.0.0.1", tunnel: "funnel" };
  if (exposeProviderNames().includes(a)) {
    // Loopback-only local bind: the tunnel reaches us over 127.0.0.1, so the
    // port is never exposed on the LAN — only the intended public URL is.
    return { label: `${a} (public tunnel)`, bindHost: "127.0.0.1", tunnel: a };
  }
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(a)) return { label: `${a} only`, bindHost: a, qrHost: a };
  const tunnels = ["tailscale-funnel", ...exposeProviderNames().filter((n) => n !== "funnel")];
  console.error(
    `error: unknown ACCESS "${a}". Use: lan, local, tailscale, ${tunnels.join(", ")}, or a literal IP.`,
  );
  return process.exit(1);
}

// BIND/EXPOSE were merged into ACCESS; warn rather than silently ignore them.
if (!process.env.ACCESS && (process.env.BIND || process.env.EXPOSE)) {
  console.error("note: BIND/EXPOSE were merged into a single ACCESS (e.g. ACCESS=tailscale-funnel). Ignoring the old vars.");
}

const access = resolveAccess();

const server = app.listen(PORT, access.bindHost, async () => {
  console.log("");
  console.log(`  even-better v${VERSION}`);
  console.log(`  Mux   : ${getMux().name}`);
  console.log(`  Access: ${access.label}`);
  if (access.tunnel) console.log(`  Local : http://127.0.0.1:${PORT}  (public URL below)`);
  console.log(`  Token : ${TOKEN}`);
  console.log(`  Log   : ${eventLogPath}`);
  console.log("");
  try {
    const agents = await refreshAgents();
    if (!defaultProviderPinned) {
      const target = agents.find((a) => a.focused) ?? agents[0];
      defaultProvider = providerForAgent(target?.agent);
    }
    for (const a of agents) {
      console.log(`  agent : ${a.agent} pane=${a.paneId} status=${a.status} cwd=${a.cwd}`);
    }
    if (agents.length === 0) {
      console.log(`  agent : (none detected — start claude/codex inside ${getMux().name})`);
    }
  } catch (err) {
    console.error(`  ${getMux().name} : NOT REACHABLE — ${(err as Error).message}`);
  }

  if (access.tunnel) {
    // The tunnel prints the one QR itself, once its public URL is up.
    startExpose(access.tunnel, PORT, appUrlFromBase);
    return;
  }
  const host = access.qrHost ?? "localhost";
  if (!access.qrHost) console.log("  (no LAN address found — showing localhost, which a phone can't reach)");
  console.log("");
  console.log(`  Scan to connect · ${urlFor(host)}`);
  if (process.env.NO_QR !== "1") qrcodeTerminal.generate(urlFor(host), { small: true }, (code) => console.log(code));
});

// Tear down both the bridges and the multiplexer (cmux holds a long-lived
// event-stream child that would otherwise outlive the process).
function teardown(): void {
  disposeAll();
  getMux().dispose?.();
}

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[bridge] port ${PORT} already in use — is another bridge running?`);
  } else {
    console.error(`[bridge] server error: ${err.message}`);
  }
  teardown();
  process.exit(1);
});

function shutdown(): void {
  teardown();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) => {
  console.error(`[bridge] uncaught: ${err.message}\n${err.stack}`);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[bridge] unhandled rejection: ${String(reason)}`);
});

// Re-export for potential programmatic use / tests.
export { emit };
