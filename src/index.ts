import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
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
import { extractModel } from "./parse.js";

const VERSION = "0.1.0";
const PORT = parseInt(process.env.PORT ?? "3456", 10);
const TOKEN = process.env.BRIDGE_TOKEN ?? randomBytes(16).toString("hex");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

function auth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const queryToken = req.query.token as string | undefined;
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : queryToken;
  if (provided !== TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

const api = express.Router();
app.use("/api", auth, api);

// ── even-terminal protocol surface ─────────────────────

api.get("/events", sseHandler);

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
    version: `${VERSION} (herdr-bridge)`,
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

function lanAddress(): string | undefined {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return undefined;
}

const server = app.listen(PORT, "0.0.0.0", async () => {
  const host = lanAddress() ?? "localhost";
  const url = `http://${host}:${PORT}?token=${TOKEN}&defaultProvider=claude`;
  console.log("");
  console.log(`  herdr-even-bridge v${VERSION}`);
  console.log(`  Local : http://localhost:${PORT}`);
  console.log(`  LAN   : http://${host}:${PORT}`);
  console.log(`  Token : ${TOKEN}`);
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
  console.log("");
  console.log(`  ${url}`);
  if (process.env.NO_QR !== "1") {
    qrcodeTerminal.generate(url, { small: true }, (code) => console.log(code));
  }
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
