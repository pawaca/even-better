import { randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
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
import { logEvent, eventLogPath, logMode, writesEventLog } from "./log.js";
import { extractModel } from "./parse.js";
import { readClaudeModel } from "./transcript.js";
import { readCodexModel } from "./codex-transcript.js";
import { startExpose, exposeProviderNames } from "./expose.js";

const VERSION = "0.1.0";
const INSTANCE_ID = process.env.INSTANCE_ID ?? String(process.pid);

function parsePort(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value || value.toLowerCase() === "auto") return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error(`error: invalid PORT "${raw}". Use a number, 0, or auto.`);
    return process.exit(1);
  }
  return port;
}

const listenPort = parsePort(process.env.PORT);

const removedEnv = [
  "ACCESS",
  "BIND",
  "EXPOSE",
  "TUNNEL",
  "BASE_PATH",
  "FUNNEL_MODE",
  "FUNNEL_PORT",
  "FUNNEL_PROGRAM_PATH",
  "EVENT_LOG",
  "EVENT_LOG_TEXT",
  "DEBUG_STREAM",
  "VERBOSE",
  "NO_QR",
  "PINGGY_PROGRAM_PATH",
  "BORE_PROGRAM_PATH",
  "NGROK_PROGRAM_PATH",
  "CLOUDFLARED_PROGRAM_PATH",
  "HERDR_SOCKET_PATH",
  "CMUX_BIN",
  "DEFAULT_PROVIDER",
].filter((name) => process.env[name] !== undefined);
if (removedEnv.length > 0) {
  console.error(
    `error: removed environment variable(s): ${removedEnv.join(", ")}. ` +
      "Use PORT, BIND_HOST, PUBLIC_ACCESS, PUBLIC_BASE_URL, BRIDGE_TOKEN, LOG, LOG_FILE, QR, or MUX.",
  );
  process.exit(1);
}

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
  if (await herdrAvailable()) found.push({ name: "herdr", make: () => new HerdrMultiplexer() });
  if (await cmuxAvailable()) found.push({ name: "cmux", make: () => new CmuxMultiplexer() });
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

// The bearer token is process-local by default. Set BRIDGE_TOKEN explicitly
// only when a stable token is wanted for a specific launch.
function resolveToken(): string {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  return randomBytes(24).toString("hex");
}
const TOKEN = resolveToken();
let defaultProvider = "claude";

function providerForAgent(agent: string | undefined): "codex" | "claude" {
  return agent === "codex" ? "codex" : "claude";
}

function normalizeBasePath(raw: string | undefined): string {
  if (!raw || raw === "/") return "";
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "/") return "";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, "");
}

function publicBasePath(raw: string | undefined): string {
  if (!raw) return "";
  try {
    return normalizeBasePath(new URL(raw).pathname);
  } catch {
    console.error(`error: invalid PUBLIC_BASE_URL "${raw}"`);
    return process.exit(1);
  }
}

function normalizePublicAccess(raw: string | undefined): string | undefined {
  const t = (raw ?? "").trim().toLowerCase();
  if (!t || t === "none") return undefined;
  if (t === "tailscale-funnel" || t === "funnel") return "funnel";
  if (exposeProviderNames().includes(t)) return t;
  const providers = ["tailscale-funnel", ...exposeProviderNames().filter((n) => n !== "funnel")];
  console.error(`error: unknown PUBLIC_ACCESS "${raw}". Use: none, ${providers.join(", ")}.`);
  return process.exit(1);
}

function resolveQr(raw: string | undefined): boolean {
  if (raw === undefined || raw === "1") return true;
  if (raw === "0") return false;
  console.error(`error: invalid QR "${raw}". Use 1 or 0.`);
  return process.exit(1);
}

function validatePublicAccessBind(raw: string | undefined): void {
  if (!publicAccess) return;
  const b = (raw ?? "auto").trim().toLowerCase();
  if (!b || b === "auto" || b === "local" || b === "localhost" || b === "127.0.0.1") return;
  console.error("error: PUBLIC_ACCESS requires BIND_HOST=auto, local, localhost, or 127.0.0.1 because providers proxy to 127.0.0.1.");
  process.exit(1);
}

const publicAccess = normalizePublicAccess(process.env.PUBLIC_ACCESS);
const publicBase = process.env.PUBLIC_BASE_URL?.trim();
if (publicBase && publicAccess) {
  console.error("error: PUBLIC_BASE_URL and PUBLIC_ACCESS are mutually exclusive; use one external URL source.");
  process.exit(1);
}
if (publicBase && listenPort === 0) {
  console.error(
    "error: PUBLIC_BASE_URL requires a fixed PORT because external proxies cannot follow auto-assigned local ports.",
  );
  process.exit(1);
}
const publicBaseMountPath = publicBasePath(publicBase);
const funnelFallbackPath = publicAccess === "funnel" ? `/eb/${INSTANCE_ID}` : "";
const basePaths = [...new Set([publicBaseMountPath, funnelFallbackPath].filter(Boolean))];
const qrEnabled = resolveQr(process.env.QR);
validatePublicAccessBind(process.env.BIND_HOST);

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
for (const basePath of basePaths) app.use(`${basePath}/api`, auth, api);

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
    // Prefer the structured model from the transcript (works for codex too, and
    // is exact); fall back to the claude status-bar scrape only if no session id
    // exists yet.
    if (target?.sessionId) {
      model =
        (target.agent === "codex"
          ? readCodexModel(target.sessionId)
          : readClaudeModel(target.sessionId)) ?? "";
    }
    if (!model && target?.agent === "claude") {
      model = extractModel(await getMux().read(target.paneId, 5));
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

function withAuth(base: string): string {
  const u = new URL(base);
  u.searchParams.set("token", TOKEN);
  u.searchParams.set("defaultProvider", defaultProvider);
  return u.toString();
}

const urlFor = (host: string, port: number): string => withAuth(`http://${host}:${port}`);
const appUrlFromBase = (base: string): string => withAuth(base);

interface Bind {
  label: string;
  bindHost: string;
  qrHost?: string; // direct modes: host to encode in the QR (undefined => offline fallback)
}

function resolveBind(): Bind {
  const raw = (process.env.BIND_HOST ?? "auto").trim().toLowerCase();
  const b = raw === "auto" ? (publicAccess || publicBase ? "local" : "lan") : raw;
  if (b === "lan") return { label: "LAN (same Wi-Fi)", bindHost: "0.0.0.0", qrHost: lanAddress() };
  if (b === "local" || b === "localhost")
    return { label: "local only (same machine)", bindHost: "127.0.0.1", qrHost: "localhost" };
  if (b === "tailscale") {
    const ts = tailscaleAddress();
    if (!ts) {
      console.error("BIND_HOST=tailscale but no Tailscale (100.64/10) address found — is Tailscale up?");
      process.exit(1);
    }
    return { label: "Tailscale (private tailnet)", bindHost: ts, qrHost: ts };
  }
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(b)) {
    return { label: `${b} only`, bindHost: b, qrHost: b === "0.0.0.0" ? lanAddress() : b };
  }
  console.error(`error: unknown BIND_HOST "${raw}". Use: auto, lan, local, tailscale, or a literal IP.`);
  return process.exit(1);
}

const bind = resolveBind();

const server = app.listen(listenPort, bind.bindHost, async () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : listenPort;
  console.log("");
  console.log(`  even-better v${VERSION}`);
  console.log(`  Instance : ${INSTANCE_ID}`);
  console.log(`  Mux      : ${getMux().name}`);
  console.log(`  Bind     : ${bind.label}`);
  console.log(`  Local    : http://${bind.bindHost === "0.0.0.0" ? "127.0.0.1" : bind.bindHost}:${actualPort}`);
  if (basePaths.length > 0) console.log(`  Paths    : ${basePaths.join(", ")}`);
  if (publicAccess) console.log(`  Public   : ${publicAccess}`);
  console.log(`  Token    : ${TOKEN}${process.env.BRIDGE_TOKEN ? " (from BRIDGE_TOKEN)" : " (ephemeral)"}`);
  console.log(`  Log mode : ${logMode}`);
  console.log(`  Log      : ${writesEventLog ? eventLogPath : "off"}`);
  console.log("");
  try {
    const agents = await refreshAgents();
    const target = agents.find((a) => a.focused) ?? agents[0];
    defaultProvider = providerForAgent(target?.agent);
    for (const a of agents) {
      console.log(`  agent : ${a.agent} pane=${a.paneId} status=${a.status} cwd=${a.cwd}`);
    }
    if (agents.length === 0) {
      console.log(`  agent : (none detected — start claude/codex inside ${getMux().name})`);
    }
  } catch (err) {
    console.error(`  ${getMux().name} : NOT REACHABLE — ${(err as Error).message}`);
  }

  if (publicBase) {
    const url = appUrlFromBase(publicBase);
    console.log("");
    console.log(`  Scan to connect · ${url}`);
    if (qrEnabled) qrcodeTerminal.generate(url, { small: true }, (code) => console.log(code));
    return;
  }

  if (publicAccess) {
    // The public-access provider prints the one QR itself, once its URL is up.
    startExpose(publicAccess, actualPort, appUrlFromBase, {
      fallbackPath: funnelFallbackPath,
      instanceId: INSTANCE_ID,
      qrEnabled,
    });
    return;
  }

  const host = bind.qrHost ?? "localhost";
  if (!bind.qrHost) console.log("  (no LAN address found — showing localhost, which a phone can't reach)");
  console.log("");
  const url = urlFor(host, actualPort);
  console.log(`  Scan to connect · ${url}`);
  if (qrEnabled) qrcodeTerminal.generate(url, { small: true }, (code) => console.log(code));
});

// Tear down both the bridges and the multiplexer (cmux holds a long-lived
// event-stream child that would otherwise outlive the process).
function teardown(): void {
  disposeAll();
  getMux().dispose?.();
}

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[bridge] port ${process.env.PORT} already in use — choose another PORT or leave it unset for auto.`);
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
