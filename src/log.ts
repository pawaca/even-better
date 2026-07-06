import { appendFileSync } from "node:fs";

// Every message exchanged with the app is appended here as one JSON line:
// {"t":"<iso>","dir":"out"|"in","sessionId":"w1:pQ","msg":{...}}
// "out" = SSE event pushed to the app, "in" = HTTP request from the app,
// "diag" = internal diagnostics (blocked-menu parsing, permission attempts).
export const eventLogPath =
  process.env.EVENT_LOG ?? "/tmp/even-better-events.log";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSensitiveKey(key: string): boolean {
  const k = key.replace(/[-_]/g, "").toLowerCase();
  return (
    k === "authorization" ||
    k === "apikey" ||
    k.endsWith("apikey") ||
    k.endsWith("password") ||
    k.endsWith("secret") ||
    k.endsWith("token")
  );
}

function redactString(value: string): string {
  return value
    .replace(/(\btoken=)[^&\s"']+/gi, "$1[REDACTED]")
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
}

export function sanitizeForLog(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => sanitizeForLog(v));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? "[REDACTED]" : sanitizeForLog(v);
  }
  return out;
}

export function logEvent(
  dir: "out" | "in" | "diag",
  sessionId: string,
  msg: unknown,
): void {
  const line = JSON.stringify({ t: new Date().toISOString(), dir, sessionId, msg: sanitizeForLog(msg) });
  try {
    // Synchronous append preserves emission order in the log. Async appendFile
    // can land out of order, which made tool_start/tool_end look reversed even
    // though the wire order was correct. Event volume is low; the cost is fine.
    appendFileSync(eventLogPath, line + "\n");
  } catch {
    // best effort — never let logging break the bridge
  }
}
