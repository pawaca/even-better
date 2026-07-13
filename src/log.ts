import { appendFileSync } from "node:fs";

export type LogMode = "off" | "normal" | "debug" | "trace";

function resolveLogMode(): LogMode {
  const mode = (process.env.LOG ?? "normal").trim().toLowerCase();
  if (mode === "off" || mode === "normal" || mode === "debug" || mode === "trace") return mode;
  console.error(`error: invalid LOG "${process.env.LOG}". Use: off, normal, debug, or trace.`);
  return process.exit(1);
}

export const logMode = resolveLogMode();

// Every message exchanged with the app is appended here as one JSON line:
// {"t":"<iso>","dir":"out"|"in","sessionId":"w1:pQ","msg":{...}}
// "out" = SSE event pushed to the app, "in" = HTTP request from the app,
// "diag" = internal diagnostics (blocked-menu parsing, permission attempts).
export const eventLogPath =
  process.env.LOG_FILE ?? `/tmp/even-better-${process.env.INSTANCE_ID ?? process.pid}.events.log`;

export const writesEventLog = logMode !== "off";
export const tracesStream = logMode === "trace";
export const logsVerboseSse = logMode === "trace";

// The human-readable diagnostic stream (`[hook]`, `[bridge]`, `[sse]`, the boot banner, …)
// goes to the terminal; teeing it here too means the lines needed to diagnose a live issue
// are already on disk without re-running with an extra flag. Separate from the JSON event
// log so `tools/` parsers stay clean.
export const consoleLogPath =
  process.env.CONSOLE_LOG_FILE ?? `/tmp/even-better-${process.env.INSTANCE_ID ?? process.pid}.log`;

/** Tee console.{log,info,warn,error} to `consoleLogPath` (timestamped + token-redacted).
 *  Call once at startup, before the banner, so everything shown is captured. Off with
 *  LOG=off. Best-effort — a file error never breaks a console call. */
export function installConsoleTee(): void {
  if (logMode === "off") return;
  const level: Array<["log" | "info" | "warn" | "error", string]> = [
    ["log", "LOG"],
    ["info", "INF"],
    ["warn", "WRN"],
    ["error", "ERR"],
  ];
  for (const [method, tag] of level) {
    const orig = console[method].bind(console);
    console[method] = (...args: unknown[]): void => {
      orig(...args);
      try {
        const text = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
        appendFileSync(consoleLogPath, `${new Date().toISOString()} ${tag} ${redactString(text)}\n`);
      } catch {
        // best effort — never let logging break a console call
      }
    };
  }
}

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
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/(\bToken\s*:\s*)[^\s(]+/g, "$1[REDACTED]"); // the "Token : <value>" banner line (colon, not the token= URL form)
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
  if (!writesEventLog) return;
  const type = isRecord(msg) && typeof msg.type === "string" ? msg.type : "";
  if (logMode === "normal" && dir === "out" && type === "text_delta") return;
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
