import { appendFileSync } from "node:fs";

// Every message exchanged with the app is appended here as one JSON line:
// {"t":"<iso>","dir":"out"|"in","sessionId":"w1:pQ","msg":{...}}
// "out" = SSE event pushed to the app, "in" = HTTP request from the app,
// "diag" = internal diagnostics (blocked-menu parsing, permission attempts).
export const eventLogPath =
  process.env.EVENT_LOG ?? "/tmp/even-better-events.log";

export function logEvent(
  dir: "out" | "in" | "diag",
  sessionId: string,
  msg: unknown,
): void {
  const line = JSON.stringify({ t: new Date().toISOString(), dir, sessionId, msg });
  try {
    // Synchronous append preserves emission order in the log. Async appendFile
    // can land out of order, which made tool_start/tool_end look reversed even
    // though the wire order was correct. Event volume is low; the cost is fine.
    appendFileSync(eventLogPath, line + "\n");
  } catch {
    // best effort — never let logging break the bridge
  }
}
