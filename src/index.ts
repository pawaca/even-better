import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import path from "node:path";
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
import { paneRead } from "./herdr.js";
import { logEvent, eventLogPath } from "./log.js";
import { extractModel } from "./parse.js";
import { startExpose } from "./expose.js";

const VERSION = "0.1.0";
const PORT = parseInt(process.env.PORT ?? "3456", 10);

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
        state: bridge.state === "idle" ? "idle" : "busy",
        sessionId,
      });
    }
  }
});

api.get("/sessions", async (_req, res) => {
  try {
    const agents = await refreshAgents();
    const sessions = agents.map((a) => ({
      id: a.pane_id,
      title: `${a.agent} · ${path.basename(a.cwd || "/")}`,
      timestamp: new Date().toISOString(),
      cwd: a.cwd,
      provider: a.agent === "codex" ? "codex" : "claude",
      status: getBridge(a.pane_id)?.state ?? "idle",
    }));
    res.json({ sessions });
  } catch (err) {
    res.json({ sessions: [], error: (err as Error).message });
  }
});

api.get("/info", async (_req, res) => {
  let model = "";
  try {
    const agents = await refreshAgents();
    const claude = agents.find((a) => a.agent === "claude") ?? agents[0];
    if (claude) {
      const text = await paneRead(claude.pane_id, "visible", 5);
      model = extractModel(text);
    }
  } catch {
    // leave model unknown
  }
  res.json({
    account: {},
    model: model || "Unknown",
    version: `${VERSION} (even-better)`,
    provider: "claude",
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
      res.status(404).json({ error: "No agent pane found in herdr" });
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

const authQuery = `token=${TOKEN}&defaultProvider=claude`;
const urlFor = (host: string): string => `http://${host}:${PORT}?${authQuery}`;
// A tunnel gives a full public base (scheme+host); just append the auth query.
const appUrlFromBase = (base: string): string => `${base}?${authQuery}`;

// Which interface to listen on. Default 0.0.0.0 (all — convenient on a trusted
// home LAN). On an untrusted network (office, public Wi-Fi) prefer BIND=tailscale
// so the port is invisible to the LAN and only reachable over the private,
// WireGuard-encrypted tailnet. BIND=lan or a literal IP also work.
function resolveBind(): { host: string; label: string } {
  const b = (process.env.BIND ?? "all").toLowerCase();
  if (b === "all" || b === "0.0.0.0") return { host: "0.0.0.0", label: "all interfaces" };
  if (b === "tailscale") {
    const ts = tailscaleAddress();
    if (!ts) {
      console.error("BIND=tailscale but no Tailscale (100.64/10) address found — is Tailscale up?");
      process.exit(1);
    }
    return { host: ts, label: "Tailscale only" };
  }
  if (b === "lan") {
    const lan = lanAddress();
    if (!lan) {
      console.error("BIND=lan but no LAN address found");
      process.exit(1);
    }
    return { host: lan, label: "LAN only" };
  }
  return { host: process.env.BIND as string, label: `${process.env.BIND} only` };
}

const bind = resolveBind();

const server = app.listen(PORT, bind.host, async () => {
  const lan = lanAddress();
  const ts = tailscaleAddress();
  console.log("");
  console.log(`  even-better v${VERSION}`);
  console.log(`  Bind      : ${bind.host} (${bind.label})`);
  console.log(`  Local     : http://localhost:${PORT}`);
  if (lan) console.log(`  LAN       : http://${lan}:${PORT}`);
  if (ts) console.log(`  Tailscale : http://${ts}:${PORT}`);
  console.log(`  Token     : ${TOKEN}`);
  console.log(`  Log       : ${eventLogPath}`);
  console.log("");
  try {
    const agents = await refreshAgents();
    for (const a of agents) {
      console.log(`  agent : ${a.agent} pane=${a.pane_id} status=${a.agent_status} cwd=${a.cwd}`);
    }
    if (agents.length === 0) {
      console.log("  agent : (none detected — start claude/codex inside herdr)");
    }
  } catch (err) {
    console.error(`  herdr : NOT REACHABLE — ${(err as Error).message}`);
  }
  // Only advertise addresses that are actually reachable given the bind. When
  // bound to all, offer both LAN and Tailscale; when bound to one interface,
  // only that one is reachable, so only its QR is shown.
  const all = [
    lan ? { label: "LAN", host: lan } : null,
    ts ? { label: "Tailscale", host: ts } : null,
  ].filter((x): x is { label: string; host: string } => x !== null);
  const targets =
    bind.host === "0.0.0.0"
      ? all.length
        ? all
        : [{ label: "Local", host: "localhost" }]
      : [{ label: bind.label, host: bind.host }];
  for (const { label, host } of targets) {
    const url = urlFor(host);
    console.log("");
    console.log(`  ${label}: ${url}`);
    if (process.env.NO_QR !== "1") {
      qrcodeTerminal.generate(url, { small: true }, (code) => console.log(code));
    }
  }
  // Optional public tunnel (EXPOSE=pinggy|bore|ngrok|cloudflared). Prints its
  // own URL + QR once the tunnel is up.
  startExpose(PORT, appUrlFromBase);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[bridge] port ${PORT} already in use — is another bridge running?`);
  } else {
    console.error(`[bridge] server error: ${err.message}`);
  }
  disposeAll();
  process.exit(1);
});

function shutdown(): void {
  disposeAll();
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
