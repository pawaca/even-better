import type { Request, Response } from "express";
import { logEvent } from "./log.js";

// Per-session message ring buffer + SSE fan-out.
// Protocol-compatible with even-terminal's routes/events.js: each SSE frame is
// `id: N\ndata: {json}\n\n`, `:ok` on connect, `:heartbeat` every 15s, and
// GET /api/messages?after=N replays from the buffer.

const MAX_MESSAGES_PER_SESSION = 500;

interface SessionBuf {
  messages: { id: number; msg: object }[];
  clients: Set<Response>;
  nextId: number;
}

const sessions = new Map<string, SessionBuf>();

function bufFor(sessionId: string): SessionBuf {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { messages: [], clients: new Set(), nextId: 1 };
    sessions.set(sessionId, s);
  }
  return s;
}

export function emit(sessionId: string, msg: object): void {
  if (!sessionId) return;
  const s = bufFor(sessionId);
  const id = s.nextId++;
  s.messages.push({ id, msg });
  if (s.messages.length > MAX_MESSAGES_PER_SESSION) s.messages.shift();
  logEvent("out", sessionId, msg);
  const type = (msg as { type?: string }).type;
  if (process.env.DEBUG_STREAM !== "0" && type !== "text_delta") {
    // text_delta is traced line-by-line in bridge.ts; summarize the rest here
    const detail = JSON.stringify(msg);
    const line = `► send ${sessionId} ${type} ${detail.length > 160 ? detail.slice(0, 160) + "…" : detail}`;
    console.log(process.stdout.isTTY ? `\x1b[36m${line}\x1b[0m` : line);
  }
  if (process.env.VERBOSE === "1") {
    console.log(`[SSE-${sessionId}] ${JSON.stringify(msg)}`);
  }
  const data = JSON.stringify(msg);
  for (const res of s.clients) {
    try {
      res.write(`id: ${id}\ndata: ${data}\n\n`);
    } catch {
      s.clients.delete(res);
    }
  }
}

export function getMessages(
  sessionId: string,
  after: number,
): ({ id: number } & object)[] {
  const s = sessions.get(sessionId);
  if (!s) return [];
  return s.messages
    .filter((m) => m.id > after)
    .map((m) => ({ id: m.id, ...m.msg }));
}

export function sseHandler(req: Request, res: Response): void {
  const sessionId = req.query.sessionId as string | undefined;
  if (!sessionId) {
    res.status(400).json({ error: "Missing 'sessionId' query parameter" });
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(":ok\n\n");

  const s = bufFor(sessionId);
  if (req.query.needReplay === "true" && s.messages.length > 0) {
    // Cap the replay: the pane may have produced hours of output while no
    // client was connected, and dumping the whole buffer floods the glasses.
    const REPLAY_MAX = 20;
    for (const entry of s.messages.slice(-REPLAY_MAX)) {
      res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.msg)}\n\n`);
    }
  }
  s.clients.add(res);
  console.log(`[sse] client connected session=${sessionId} (clients: ${s.clients.size})`);

  const heartbeat = setInterval(() => {
    try {
      res.write(":heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
      s.clients.delete(res);
    }
  }, 15_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    s.clients.delete(res);
    console.log(`[sse] client disconnected session=${sessionId}`);
  });
}
