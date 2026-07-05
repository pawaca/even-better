import net from "node:net";
import os from "node:os";
import path from "node:path";

const SOCKET_PATH =
  process.env.HERDR_SOCKET_PATH ??
  path.join(os.homedir(), ".config", "herdr", "herdr.sock");

// Methods we allow ourselves to call. Anything server.* is deliberately
// excluded — reload/stop/handoff must never be reachable from the bridge.
const SAFE_METHODS = new Set([
  "agent.list",
  "pane.get",
  "pane.read",
  "pane.send_input",
  "events.subscribe",
  // used by the self-test only:
  "workspace.create",
  "workspace.close",
  "pane.report_agent",
]);

let seq = 0;

/** One-shot RPC: fresh connection, one request line, one response line. */
export function call<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  if (!SAFE_METHODS.has(method)) {
    return Promise.reject(new Error(`method not allowed: ${method}`));
  }
  return new Promise((resolve, reject) => {
    const conn = net.connect(SOCKET_PATH);
    let buf = "";
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      conn.destroy();
      reject(err);
    };
    conn.on("connect", () => {
      conn.write(
        JSON.stringify({ id: `bridge-${++seq}`, method, params }) + "\n",
      );
    });
    conn.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      settled = true;
      conn.end();
      try {
        const resp = JSON.parse(line) as {
          result?: T;
          error?: { code: string; message: string };
        };
        if (resp.error) {
          reject(new Error(`${resp.error.code}: ${resp.error.message}`));
        } else {
          resolve(resp.result as T);
        }
      } catch (err) {
        reject(err as Error);
      }
    });
    conn.on("error", fail);
    conn.setTimeout(10_000, () => fail(new Error(`herdr call timeout: ${method}`)));
  });
}

export interface SubscriptionSpec extends Record<string, unknown> {
  type: string;
}

export interface SubscribeHandle {
  close: () => void;
}

/**
 * Long-lived subscription connection. herdr pushes one JSON line per event:
 * {"event":"pane.output_matched","data":{...}}. The connection stays open
 * until closed. onClose fires on any disconnect (caller decides to retry).
 */
export function subscribe(
  subs: SubscriptionSpec[],
  onEvent: (event: string, data: Record<string, unknown>) => void,
  onClose: (err?: Error) => void,
): SubscribeHandle {
  const conn = net.connect(SOCKET_PATH);
  let buf = "";
  let closedByUs = false;
  conn.on("connect", () => {
    conn.write(
      JSON.stringify({
        id: "bridge-sub",
        method: "events.subscribe",
        params: { subscriptions: subs },
      }) + "\n",
    );
  });
  conn.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as {
          event?: string;
          data?: Record<string, unknown>;
          error?: { code: string; message: string };
        };
        if (msg.error) {
          console.error(`[herdr-sub] error: ${msg.error.code}: ${msg.error.message}`);
        } else if (msg.event) {
          onEvent(msg.event, msg.data ?? {});
        }
        // the initial {id, result:{type:"subscription_started"}} ack is ignored
      } catch {
        // ignore unparseable lines
      }
    }
  });
  conn.on("error", (err) => {
    if (!closedByUs) onClose(err);
  });
  conn.on("close", () => {
    if (!closedByUs) onClose();
  });
  return {
    close: () => {
      closedByUs = true;
      conn.end();
    },
  };
}

// ── typed wrappers ─────────────────────────────────────

export interface AgentInfo {
  terminal_id: string;
  agent: string;
  agent_status: "idle" | "working" | "blocked" | "done" | "unknown";
  agent_session?: { source: string; agent: string; kind: string; value: string };
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  focused: boolean;
  cwd: string;
  foreground_cwd: string;
}

export async function agentList(): Promise<AgentInfo[]> {
  const r = await call<{ agents: AgentInfo[] }>("agent.list");
  return r.agents ?? [];
}

export async function paneRead(
  paneId: string,
  source: "visible" | "recent" | "recent_unwrapped",
  lines: number,
): Promise<string> {
  const r = await call<{ read: { text: string } }>("pane.read", {
    pane_id: paneId,
    source,
    lines,
  });
  return r.read?.text ?? "";
}

/** Type text into a pane; keys (e.g. ["Enter"]) are pressed after the text. */
export async function sendInput(
  paneId: string,
  text: string,
  keys?: string[],
): Promise<void> {
  const params: Record<string, unknown> = { pane_id: paneId, text };
  if (keys && keys.length > 0) params.keys = keys;
  await call("pane.send_input", params);
}

export async function paneExists(paneId: string): Promise<boolean> {
  try {
    await call("pane.get", { pane_id: paneId });
    return true;
  } catch {
    return false;
  }
}
