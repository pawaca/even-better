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
// Diagnostic only: when each session last lost its client, to log reconnect gaps.
const lastDisconnectAt = new Map<string, number>();

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
  const type = (msg as { type?: string }).type;
  const s = bufFor(sessionId);
  const id = s.nextId++;
  s.messages.push({ id, msg });
  if (s.messages.length > MAX_MESSAGES_PER_SESSION) s.messages.shift();
  // EVENT_LOG keeps full fidelity by default; set EVENT_LOG_TEXT=0 to suppress
  // high-volume text_delta rows while preserving the app's SSE stream.
  if (type !== "text_delta" || process.env.EVENT_LOG_TEXT !== "0") {
    logEvent("out", sessionId, msg);
  }
  if (process.env.DEBUG_STREAM !== "0" && type !== "text_delta") {
    // text_delta is traced line-by-line in bridge.ts; summarize the rest here
    const detail = JSON.stringify(msg);
    const line = `► send ${sessionId} ${type} ${detail.length > 160 ? detail.slice(0, 160) + "…" : detail}`;
    console.log(process.stdout.isTTY ? `\x1b[36m${line}\x1b[0m` : line);
  }
  if (process.env.VERBOSE === "1") {
    console.log(`[SSE-${sessionId}] ${JSON.stringify(msg)}`);
  }
  // Diagnostic: the agent is producing output but no live client is attached, so
  // it only lands in the buffer. A run of these during a "frozen glass" window
  // means the drop went unnoticed (half-open socket) or the app hasn't
  // reconnected. (Skip text_delta to avoid flooding the log.)
  if (s.clients.size === 0 && type !== "text_delta") {
    console.log(`[sse] no live client — buffering session=${sessionId} type=${type} buffered=${s.messages.length}`);
  }
  const data = JSON.stringify(msg);
  for (const res of s.clients) {
    try {
      res.write(`id: ${id}\ndata: ${data}\n\n`);
    } catch {
      s.clients.delete(res);
      // When this fires long after the glass actually went quiet, the gap
      // between that wall-clock and now is the half-open dead-socket window.
      console.warn(`[sse] write failed — dropped dead client session=${sessionId} clients=${s.clients.size}`);
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
  // Tell the app's EventSource to reconnect fast (default is 3s) and keep
  // retrying persistently — so a dropped stream re-establishes quickly once the
  // client notices it's dead (the keepalive below is what makes it notice).
  res.write("retry: 2000\n\n");

  // Enable TCP keepalive so a phone that drops off the network (Wi-Fi loss,
  // suspend) is detected by the OS in ~tens of seconds instead of TCP's default
  // multi-minute retransmit timeout — otherwise the server keeps writing SSE
  // frames into a half-open socket the glass can no longer receive. The socket
  // `error` (ECONNRESET / ETIMEDOUT / EPIPE) is also the clearest signal of how
  // the connection actually died; `close` still drives cleanup below.
  res.socket?.setKeepAlive(true, 15_000);
  res.socket?.on("error", (err) => {
    const code = (err as NodeJS.ErrnoException).code ?? err.message;
    console.warn(`[sse] socket error session=${sessionId} code=${code}`);
  });

  const s = bufFor(sessionId);
  const needReplay = req.query.needReplay === "true";
  if (needReplay && s.messages.length > 0) {
    // Cap the replay: the pane may have produced hours of output while no
    // client was connected, and dumping the whole buffer floods the glasses.
    const REPLAY_MAX = 20;
    for (const entry of s.messages.slice(-REPLAY_MAX)) {
      res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.msg)}\n\n`);
    }
  }
  s.clients.add(res);
  const connectedAt = Date.now();
  // Diagnostic: reconnect gap (how long the glass had no live stream), whether
  // the app asked for replay, and whether it sent a standard Last-Event-ID (if
  // it does, honoring that header would give precise gap-free replay).
  const prevOff = lastDisconnectAt.get(sessionId);
  const gap = prevOff ? `${Math.round((connectedAt - prevOff) / 1000)}s` : "first";
  const lastEventId = req.headers["last-event-id"];
  console.log(
    `[sse] connect session=${sessionId} reconnect_gap=${gap} needReplay=${needReplay} ` +
      `lastEventId=${lastEventId ?? "-"} buffered=${s.messages.length} clients=${s.clients.size}`,
  );

  const heartbeat = setInterval(() => {
    try {
      res.write(":heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
      s.clients.delete(res);
      // Heartbeat is the main way a half-open socket is noticed; the delay from
      // the real network drop to this line is the detection latency.
      const lived = Math.round((Date.now() - connectedAt) / 1000);
      console.warn(`[sse] heartbeat failed — dropped dead client session=${sessionId} lived=${lived}s`);
    }
  }, 15_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    s.clients.delete(res);
    lastDisconnectAt.set(sessionId, Date.now());
    const lived = Math.round((Date.now() - connectedAt) / 1000);
    console.log(`[sse] disconnect session=${sessionId} lived=${lived}s clients=${s.clients.size}`);
  });
}
