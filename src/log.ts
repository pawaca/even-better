import { appendFile } from "node:fs";

// Every message exchanged with the app is appended here as one JSON line:
// {"t":"<iso>","dir":"out"|"in","sessionId":"w1:pQ","msg":{...}}
// "out" = SSE event pushed to the app, "in" = HTTP request from the app,
// "diag" = internal diagnostics (blocked-menu parsing, permission attempts).
export const eventLogPath =
  process.env.EVENT_LOG ?? "/tmp/herdr-even-bridge-events.log";

export function logEvent(
  dir: "out" | "in" | "diag",
  sessionId: string,
  msg: unknown,
): void {
  const line = JSON.stringify({ t: new Date().toISOString(), dir, sessionId, msg });
  appendFile(eventLogPath, line + "\n", () => {
    // best effort — never let logging break the bridge
  });
}
