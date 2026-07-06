import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Multiplexer, PaneInfo, PaneStatus, StatusSub } from "./multiplexer.js";

// cmux Multiplexer: drives the `cmux` CLI over its Unix socket. Pane identity is
// a surface UUID. Unlike herdr — which detects agents from the PTY and hands us
// an `agent_session` — cmux learns the agent's native session id through agent
// *hooks* (installed with `cmux hooks setup --agent claude|codex`), which write
// ~/.cmuxterm/<agent>-hook-sessions.json AND emit `agent.hook.*` events. So:
//   - listPanes / sessionId  ← the hook-sessions file + `surface resume get`
//   - watchStatus            ← one shared `cmux events` stream, routed per surface
//   - read / send            ← `cmux read-screen` / `cmux send`+`send-key`
// There is no rule-based classifier, so `explain` is intentionally omitted and
// blocked menus fall back to screen parsing (see docs/ARCHITECTURE.md).

// Agents we can mirror with a structured transcript. Their hook-session files
// are named <agent>-hook-sessions.json.
const AGENTS = ["claude", "codex"] as const;

const CMUX_HOME = join(homedir(), ".cmuxterm");

/** Resolve the cmux binary: CMUX_BIN, then PATH, then the macOS app bundle. */
function resolveCmuxBin(): string {
  if (process.env.CMUX_BIN) return process.env.CMUX_BIN;
  const bundled = "/Applications/cmux.app/Contents/Resources/bin/cmux";
  if (existsSync(bundled)) return bundled;
  return "cmux";
}

const CMUX_BIN = resolveCmuxBin();

/** The cmux binary exists — CMUX_BIN, the macOS app bundle, or `cmux` on PATH. */
function cmuxBinExists(): boolean {
  if (process.env.CMUX_BIN) return existsSync(process.env.CMUX_BIN);
  if (existsSync("/Applications/cmux.app/Contents/Resources/bin/cmux")) return true;
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir && existsSync(join(dir, "cmux")));
}

/** True when cmux looks usable on this machine (binary present + its state dir).
 *  Cheap and synchronous so startup selection needn't spawn a probe. */
export function cmuxAvailable(): boolean {
  return cmuxBinExists() && existsSync(CMUX_HOME);
}

function cmux(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      CMUX_BIN,
      args,
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(typeof stdout === "string" ? stdout : String(stdout));
      },
    );
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Agent session ids arrive prefixed by source (`claude-<uuid>`) in events but
 *  bare (`<uuid>`) in the hook file and `checkpoint_id`. Reduce to the trailing
 *  UUID so both forms compare equal; fall back to a leading-source strip. */
function bareSession(id: string): string {
  const uuid = id.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  if (uuid) return uuid[0];
  const m = id.match(/^[a-z]+-(.+)$/);
  return m ? m[1] : id;
}

const KEY_MAP: Record<string, string> = {
  Enter: "enter",
  Escape: "escape",
  Down: "down",
  Up: "up",
  Left: "left",
  Right: "right",
  Tab: "tab",
  Space: "space",
};

// ── hook-sessions file shape (only the fields we read) ──

interface HookSessionEntry {
  cwd?: string;
  surfaceId?: string;
  workspaceId?: string;
  sessionId?: string;
}
interface HookSessionsFile {
  activeSessionsBySurface?: Record<string, { sessionId?: string }>;
  sessions?: Record<string, HookSessionEntry>;
}

interface SurfaceMeta {
  agent: string;
  cwd: string;
  workspaceId: string | undefined;
  session: string; // bare session id
}

interface Listener {
  onStatus: (s: PaneStatus) => void;
  onClose: (err?: Error) => void;
}

export class CmuxMultiplexer implements Multiplexer {
  readonly name = "cmux";

  private readonly listeners = new Map<string, Listener>();
  private readonly lastStatus = new Map<string, PaneStatus>();
  // Rebuilt from the hook files; routes prefix-stripped session ids and
  // workspaces to the surface an agent.hook.* event belongs to.
  private surfaceMeta = new Map<string, SurfaceMeta>();
  private sessionToSurface = new Map<string, string>();
  private workspaceToSurface = new Map<string, string>();
  private focusedSurface: string | undefined;

  private proc: ChildProcess | null = null;
  private buf = "";
  private restartTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor() {
    this.refreshMaps();
    this.ensureEvents();
  }

  // ── discovery ────────────────────────────────────────

  /** Re-read both hook-session files into the routing maps. Their
   *  activeSessionsBySurface is cmux's own index of live agent surfaces. */
  private refreshMaps(): void {
    const surfaceMeta = new Map<string, SurfaceMeta>();
    const sessionToSurface = new Map<string, string>();
    const workspaceToSurface = new Map<string, string>();
    for (const agent of AGENTS) {
      const file = join(CMUX_HOME, `${agent}-hook-sessions.json`);
      if (!existsSync(file)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      if (!isRecord(parsed)) continue;
      const data = parsed as HookSessionsFile;
      const active = data.activeSessionsBySurface ?? {};
      const sessions = data.sessions ?? {};
      for (const [surfaceId, ref] of Object.entries(active)) {
        const sid = ref?.sessionId;
        if (!sid) continue;
        const entry = sessions[sid] ?? {};
        const bare = bareSession(sid);
        surfaceMeta.set(surfaceId, {
          agent,
          cwd: entry.cwd ?? "",
          workspaceId: entry.workspaceId,
          session: bare,
        });
        sessionToSurface.set(bare, surfaceId);
        if (entry.workspaceId) workspaceToSurface.set(entry.workspaceId, surfaceId);
      }
    }
    this.surfaceMeta = surfaceMeta;
    this.sessionToSurface = sessionToSurface;
    this.workspaceToSurface = workspaceToSurface;
  }

  async listPanes(): Promise<PaneInfo[]> {
    this.refreshMaps();
    const panes: PaneInfo[] = [];
    for (const [surfaceId, meta] of this.surfaceMeta) {
      panes.push({
        paneId: surfaceId,
        agent: meta.agent,
        cwd: meta.cwd,
        focused: surfaceId === this.focusedSurface,
        status: this.lastStatus.get(surfaceId) ?? "idle",
        sessionId: meta.session,
      });
    }
    return panes;
  }

  // ── status stream ────────────────────────────────────

  watchStatus(
    paneId: string,
    onStatus: (s: PaneStatus) => void,
    onClose: (err?: Error) => void,
  ): StatusSub {
    this.listeners.set(paneId, { onStatus, onClose });
    this.ensureEvents();
    return {
      close: () => {
        this.listeners.delete(paneId);
      },
    };
  }

  private ensureEvents(): void {
    if (this.proc || this.disposed) return;
    // One shared stream for all surfaces; agent + surface categories cover the
    // agent.hook.* lifecycle and surface.created/closed/focused we route on.
    this.proc = spawn(
      CMUX_BIN,
      ["events", "--reconnect", "--no-heartbeat", "--no-ack", "--category", "agent", "--category", "surface"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    this.proc.stdout?.setEncoding("utf8");
    this.proc.stdout?.on("data", (chunk: string) => this.onData(chunk));
    this.proc.on("error", () => this.onProcExit());
    this.proc.on("close", () => this.onProcExit());
  }

  private onProcExit(): void {
    this.proc = null;
    if (this.disposed || this.restartTimer) return;
    // `--reconnect` handles socket drops internally; a full exit means the CLI
    // itself died (cmux restart). Notify watchers and respawn shortly.
    for (const l of this.listeners.values()) l.onClose();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.disposed && this.listeners.size > 0) this.ensureEvents();
    }, 2000);
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let evt: unknown;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (isRecord(evt)) this.onEvent(evt);
    }
  }

  private onEvent(evt: Record<string, unknown>): void {
    const name = typeof evt.name === "string" ? evt.name : "";
    const payload = isRecord(evt.payload) ? evt.payload : {};
    const topSurface = typeof evt.surface_id === "string" ? evt.surface_id : undefined;
    const paySurface = typeof payload.surface_id === "string" ? payload.surface_id : undefined;

    switch (name) {
      case "surface.focused":
      case "surface.selected": {
        const s = topSurface ?? paySurface;
        if (s) this.focusedSurface = s;
        return;
      }
      case "surface.closed": {
        const s = topSurface ?? paySurface;
        if (s) this.routeStatus(s, "closed");
        return;
      }
      case "surface.created":
      case "agent.hook.SessionStart":
        // A new agent surface/session appeared — the hook file was just
        // (re)written, so refresh routing so subsequent events resolve.
        this.refreshMaps();
        return;
      case "agent.hook.UserPromptSubmit":
      case "agent.hook.PreToolUse":
        this.routeAgent(payload, "busy");
        return;
      case "agent.hook.Stop":
        this.routeAgent(payload, "idle");
        return;
      case "agent.hook.Notification":
        this.routeAgent(payload, "awaiting");
        return;
      default:
        return;
    }
  }

  /** Resolve which tracked surface an agent.hook.* event belongs to. The event
   *  carries session_id + workspace_id but not surface_id, so map via those. */
  private surfaceForAgentEvent(payload: Record<string, unknown>): string | undefined {
    const sid = typeof payload.session_id === "string" ? bareSession(payload.session_id) : undefined;
    if (sid) {
      let s = this.sessionToSurface.get(sid);
      if (!s) {
        this.refreshMaps();
        s = this.sessionToSurface.get(sid);
      }
      if (s) return s;
    }
    const wid = typeof payload.workspace_id === "string" ? payload.workspace_id : undefined;
    if (wid) return this.workspaceToSurface.get(wid);
    return undefined;
  }

  private routeAgent(payload: Record<string, unknown>, status: PaneStatus): void {
    const surface = this.surfaceForAgentEvent(payload);
    if (surface) this.routeStatus(surface, status);
  }

  private routeStatus(surfaceId: string, status: PaneStatus): void {
    this.lastStatus.set(surfaceId, status);
    if (status === "closed") {
      this.surfaceMeta.delete(surfaceId);
      this.lastStatus.delete(surfaceId);
    }
    this.listeners.get(surfaceId)?.onStatus(status);
  }

  // ── pane I/O ─────────────────────────────────────────

  async read(paneId: string, _lines: number): Promise<string> {
    // Visible viewport (matches herdr "visible"); --lines would force scrollback.
    return cmux(["read-screen", "--surface", paneId]);
  }

  async send(paneId: string, text: string, keys?: string[]): Promise<void> {
    if (text) await cmux(["send", "--surface", paneId, "--", text]);
    for (const key of keys ?? []) {
      const mapped = KEY_MAP[key] ?? key.toLowerCase();
      await cmux(["send-key", "--surface", paneId, "--", mapped]);
    }
  }

  async sessionId(paneId: string): Promise<string | undefined> {
    let out: string;
    try {
      out = await cmux(["surface", "resume", "get", "--json", "--surface", paneId]);
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch {
      return undefined;
    }
    if (!isRecord(parsed) || !isRecord(parsed.resume_binding)) return undefined;
    const b = parsed.resume_binding;
    const kind = typeof b.kind === "string" ? b.kind : "";
    if (kind !== "claude" && kind !== "codex") return undefined;
    return typeof b.checkpoint_id === "string" ? bareSession(b.checkpoint_id) : undefined;
  }

  async exists(paneId: string): Promise<boolean> {
    try {
      await cmux(["surface", "resume", "get", "--json", "--surface", paneId]);
      return true;
    } catch {
      return false;
    }
  }

  // no explain(): cmux has no pane-state classifier — blocked menus fall back to
  // screen parsing, which the optional-capability contract already handles.

  dispose(): void {
    this.disposed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.proc?.kill();
    this.proc = null;
    this.listeners.clear();
  }
}
