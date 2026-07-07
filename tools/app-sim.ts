// Minimal Even-app simulator: connects to the bridge exactly like the app
// (GET /sessions, SSE /events with needReplay, periodic /sessions polls) and
// records every SSE event to a JSONL file for offline analysis.
//
// Usage: tsx scripts/app-sim.ts <port> <token> <sessionId> <outFile> [durationMs]

const [port, token, sessionId, outFile, durationArg] = process.argv.slice(2);
const durationMs = parseInt(durationArg ?? "60000", 10);
if (!port || !token || !sessionId || !outFile) {
  console.error("usage: app-sim <port> <token> <sessionId> <outFile> [durationMs]");
  process.exit(1);
}

const base = `http://localhost:${port}/api`;
const { appendFileSync, writeFileSync } = await import("node:fs");
writeFileSync(outFile, "");

function record(kind: string, payload: unknown): void {
  appendFileSync(
    outFile,
    JSON.stringify({ t: new Date().toISOString(), kind, payload }) + "\n",
  );
}

// 1. list sessions like the app does on connect
const sessions = await fetch(`${base}/sessions?token=${token}`).then((r) => r.json());
record("sessions", sessions);

// 2. periodic /sessions poll (the app does this every 10s)
const poll = setInterval(() => {
  fetch(`${base}/sessions?token=${token}`)
    .then((r) => r.json())
    .then((j) => record("sessions-poll", { count: (j as { sessions: unknown[] }).sessions?.length }))
    .catch(() => {});
}, 10_000);

// 3. SSE stream
const res = await fetch(
  `${base}/events?sessionId=${encodeURIComponent(sessionId)}&needReplay=true&token=${token}`,
);
if (!res.ok || !res.body) {
  console.error(`SSE connect failed: ${res.status}`);
  process.exit(1);
}
console.log(`[sim] SSE connected for ${sessionId}, recording to ${outFile} for ${durationMs}ms`);

const deadline = Date.now() + durationMs;
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = "";
const timer = setTimeout(() => {
  clearInterval(poll);
  reader.cancel().catch(() => {});
  console.log("[sim] done");
  process.exit(0);
}, durationMs);
timer.unref?.();

try {
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (dataLine) {
        try {
          record("sse", JSON.parse(dataLine.slice(6)));
        } catch {
          record("sse-raw", dataLine.slice(6));
        }
      }
    }
  }
} catch {
  // stream closed
}
clearInterval(poll);
console.log("[sim] done");
