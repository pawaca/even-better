import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Multiplexer, PaneInfo, PaneStatus, StatusSub } from "./multiplexer.js";
import { isCodexApprovalScreen } from "./parse.js";

// Codex delivers exec/patch approvals as protocol events, not hooks (and they are
// not persisted to the rollout), so — unlike claude — no `agent.hook.*` marks the
// pane blocked. While a codex surface is busy we poll its screen for the approval
// prompt and synthesize `awaiting`; the bridge's normal blocked-menu path handles
// the rest. See docs/PERMISSIONS.md §① for why the screen is the only signal.
const CODEX_APPROVAL_POLL_MS = 700;

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

/** Resolve the cmux binary: the macOS app bundle, then PATH. */
function resolveCmuxBin(): string {
  const bundled = "/Applications/cmux.app/Contents/Resources/bin/cmux";
  if (existsSync(bundled)) return bundled;
  return "cmux";
}

const CMUX_BIN = resolveCmuxBin();

/** The cmux binary exists — the macOS app bundle, or `cmux` on PATH. */
function cmuxBinExists(): boolean {
  if (existsSync("/Applications/cmux.app/Contents/Resources/bin/cmux")) return true;
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir && existsSync(join(dir, "cmux")));
}

/** True when cmux is actually RUNNING here. Probes with `cmux ping` (~20ms) so
 *  the CLI resolves its own socket — robust across versions and socket paths
 *  (default differs by build), unlike checking persisted ~/.cmuxterm state or a
 *  hard-coded socket path. Async because it spawns the probe. */
export async function cmuxAvailable(): Promise<boolean> {
  if (!cmuxBinExists()) return false;
  try {
    await cmux(["ping"]);
    return true;
  } catch {
    return false;
  }
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

/** Whether a pid is a live process. Signal 0 only probes; EPERM means it exists
 *  but is owned by another user (still alive), ESRCH means it is gone. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
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
  pid?: number;
}
interface HookSessionsFile {
  activeSessionsBySurface?: Record<string, { sessionId?: string }>;
  activeSessionsByWorkspace?: Record<string, { sessionId?: string }>;
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
  // Which kind of interactive blocker last opened per surface, so the bridge can
  // render a question as a question even when screen parsing is inconclusive.
  private readonly lastKind = new Map<string, "permission" | "question">();
  // Rebuilt from the hook files; routes prefix-stripped session ids and
  // workspaces to the surface an agent.hook.* event belongs to.
  private surfaceMeta = new Map<string, SurfaceMeta>();
  private sessionToSurface = new Map<string, string>();
  private workspaceToSurface = new Map<string, string>();
  private focusedSurface: string | undefined;
  // Codex-only: screen-poll a busy codex surface for an approval prompt (no hook
  // exists for it). `codexScreenAwaiting` tracks surfaces we drove to awaiting
  // from the screen so a stale busy hook can't clobber an open menu.
  private readonly codexPollTimers = new Map<string, NodeJS.Timeout>();
  private readonly codexPollInFlight = new Set<string>();
  private readonly codexScreenAwaiting = new Set<string>();
  // A terminal (Stop/idle) hook that arrived while an approval was on screen —
  // applied when the poll observes the footer clear, so the turn ends even
  // though the hook was withheld to protect the live menu.
  private readonly codexIdlePending = new Set<string>();

  private proc: ChildProcess | null = null;
  private buf = "";
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
      const add = (surfaceId: string, bare: string, entry: HookSessionEntry): void => {
        if (surfaceMeta.has(surfaceId)) return;
        surfaceMeta.set(surfaceId, {
          agent,
          cwd: entry.cwd ?? "",
          workspaceId: entry.workspaceId,
          session: bare,
        });
        sessionToSurface.set(bare, surfaceId);
        if (entry.workspaceId) workspaceToSurface.set(entry.workspaceId, surfaceId);
      };
      // Primary index: cmux's own active-surface map (restorable sessions live
      // here without a surfaceId of their own). cmux does not always prune a
      // session whose process has exited, so drop entries with a dead pid —
      // otherwise even-better lists a zombie. (No-pid entries are restorable /
      // not-yet-running, not dead; keep them.)
      for (const [surfaceId, ref] of Object.entries(active)) {
        const sid = ref?.sessionId;
        if (!sid) continue;
        const entry = sessions[sid] ?? {};
        if (entry.pid && !pidAlive(entry.pid)) continue;
        add(surfaceId, bareSession(sid), entry);
      }
      // A `--command`-launched agent lands only in `sessions` with its own
      // surfaceId+pid and is absent from activeSessionsBySurface, so also take
      // live (pid-alive) sessions map entries. pid-liveness drops stale ones.
      for (const [sid, entry] of Object.entries(sessions)) {
        if (entry.surfaceId && entry.pid && pidAlive(entry.pid)) {
          add(entry.surfaceId, bareSession(entry.sessionId ?? sid), entry);
        }
      }
      // Some restored/hook-captured sessions appear only in the workspace index.
      // Resolve the surface from the sessions map, dropping a dead pid here too.
      // (Ones with no surfaceId anywhere can't be placed without cmux topology;
      // event-time routing still reaches them by session.)
      for (const ref of Object.values(data.activeSessionsByWorkspace ?? {})) {
        const sid = ref?.sessionId;
        const entry = sid ? sessions[sid] : undefined;
        if (!sid || !entry?.surfaceId) continue;
        if (entry.pid && !pidAlive(entry.pid)) continue;
        add(entry.surfaceId, bareSession(sid), entry);
      }
    }
    this.surfaceMeta = surfaceMeta;
    this.sessionToSurface = sessionToSurface;
    this.workspaceToSurface = workspaceToSurface;
  }

  /** Seed the focused surface authoritatively. `surface.focused` events keep it
   *  live afterwards, but at startup none have fired yet, so without this every
   *  pane reports focused:false and a no-sessionId prompt could target an
   *  arbitrary older surface. */
  private async resolveFocused(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await cmux(["--id-format", "both", "identify", "--json"]));
      if (!isRecord(parsed)) return;
      // Prefer the focused surface; fall back to the caller context, which other
      // cmux builds report instead of a `focused` object.
      const ctx = isRecord(parsed.focused) ? parsed.focused : isRecord(parsed.caller) ? parsed.caller : undefined;
      if (ctx && typeof ctx.surface_id === "string") this.focusedSurface = ctx.surface_id;
    } catch {
      // leave focus as last known (from events); listPanes still returns panes
    }
  }

  async listPanes(): Promise<PaneInfo[]> {
    this.refreshMaps();
    await this.resolveFocused();
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
    if (this.disposed) return;
    // `--reconnect` handles socket drops internally; a full exit means the CLI
    // itself died (cmux restart). Every StatusSub is now dead, so clear them and
    // notify: live bridges re-register (their retry -> watchStatus ->
    // ensureEvents respawns the stream), disposed ones don't — so no stale
    // listener lingers and we never respawn solely for panes that are gone.
    const subs = [...this.listeners.values()];
    this.listeners.clear();
    for (const l of subs) l.onClose();
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
    // cmux delivers each agent.hook.* event twice — once per phase ("received"
    // then "completed"). Act on a single phase so every hook drives exactly one
    // status transition; double-processing strands turns (a duplicate `busy`
    // after Stop cancels the idle debounce with no re-arm) and re-emits menus.
    if (name.startsWith("agent.hook.") && payload.phase === "completed") return;
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
        this.routeAgent(payload, "busy");
        return;
      case "agent.hook.PreToolUse": {
        // A few tools block on a menu without a dedicated hook: ExitPlanMode
        // (plan approval) has no distinct event, and on some builds
        // AskUserQuestion arrives only here. Route those to the interaction path
        // so the glasses can answer; every other tool is ordinary work.
        const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
        if (tool === "AskUserQuestion" || tool === "ExitPlanMode") {
          this.routeInteraction(payload, "question");
        } else {
          this.routeAgent(payload, "busy");
        }
        return;
      }
      case "agent.hook.Stop":
        this.routeAgent(payload, "idle");
        return;
      // Authoritative interactive blockers — a menu is genuinely open and can be
      // answered from the glasses. Carry the kind so the bridge shows a question
      // as a question, not a synthesized permission. (Notification is NOT here:
      // it also fires for non-blocking idle reminders and carries no message.)
      case "agent.hook.PermissionRequest":
        this.routeInteraction(payload, "permission");
        return;
      case "agent.hook.AskUserQuestion":
        this.routeInteraction(payload, "question");
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
    if (!surface) return;
    const isCodex = this.surfaceMeta.get(surface)?.agent === "codex";
    if (isCodex && this.codexScreenAwaiting.has(surface)) {
      // The screen shows a codex approval — it is authoritative. A busy hook must
      // not clobber the open menu; a Stop/idle (codex fires it at turn end, after
      // the menu is answered — never while open) is REMEMBERED, not applied, and
      // the poll ends the turn when it sees the footer clear. Deferring via a flag
      // (not a screen read) keeps a transient read failure from losing the only
      // idle signal and stranding the pane as busy.
      if (status !== "busy") this.codexIdlePending.add(surface);
      return;
    }
    this.routeStatus(surface, status);
    if (isCodex) {
      if (status === "busy") this.startCodexApprovalPoll(surface);
      else this.stopCodexApprovalPoll(surface);
    }
  }

  /** Screen-poll a busy codex surface for an approval prompt and synthesize
   *  `awaiting`/`busy` around it — codex has no approval hook (§① of
   *  docs/PERMISSIONS.md). No-op for claude, whose hook is authoritative. */
  private startCodexApprovalPoll(surface: string): void {
    if (this.codexPollTimers.has(surface) || this.disposed) return;
    const timer = setInterval(() => void this.checkCodexApproval(surface), CODEX_APPROVAL_POLL_MS);
    this.codexPollTimers.set(surface, timer);
  }

  private stopCodexApprovalPoll(surface: string): void {
    const t = this.codexPollTimers.get(surface);
    if (t) clearInterval(t);
    this.codexPollTimers.delete(surface);
    this.codexPollInFlight.delete(surface);
    this.codexScreenAwaiting.delete(surface);
    this.codexIdlePending.delete(surface);
  }

  private async checkCodexApproval(surface: string): Promise<void> {
    if (this.codexPollInFlight.has(surface)) return; // reads can outlast the tick
    this.codexPollInFlight.add(surface);
    let screen = "";
    try {
      screen = await this.read(surface, 0);
    } catch {
      return; // transient read failure; keep current state, retry next tick
    } finally {
      this.codexPollInFlight.delete(surface);
    }
    // The poll may have been stopped (idle/Stop/close) while this read was in
    // flight — the snapshot is stale. Drop it rather than route on it, which
    // could re-arm `awaiting` with no timer left to ever observe it clear.
    if (!this.codexPollTimers.has(surface)) return;
    const blocked = isCodexApprovalScreen(screen);
    if (blocked && !this.codexScreenAwaiting.has(surface)) {
      this.codexScreenAwaiting.add(surface);
      this.lastKind.set(surface, "permission");
      this.routeStatus(surface, "awaiting");
    } else if (!blocked && this.codexScreenAwaiting.has(surface)) {
      this.codexScreenAwaiting.delete(surface);
      if (this.codexIdlePending.delete(surface)) {
        // A Stop/idle arrived while the menu was up → the turn has ended.
        this.stopCodexApprovalPoll(surface);
        this.routeStatus(surface, "idle");
      } else {
        this.routeStatus(surface, "busy"); // menu cleared mid-turn → still working
      }
    }
  }

  private routeInteraction(payload: Record<string, unknown>, kind: "permission" | "question"): void {
    const surface = this.surfaceForAgentEvent(payload);
    if (!surface) return;
    this.lastKind.set(surface, kind);
    this.routeStatus(surface, "awaiting");
  }

  /** The kind of the interactive blocker currently open on a surface. */
  interactionKind(paneId: string): "permission" | "question" | undefined {
    return this.lastKind.get(paneId);
  }

  private routeStatus(surfaceId: string, status: PaneStatus): void {
    this.lastStatus.set(surfaceId, status);
    if (status === "closed") {
      this.stopCodexApprovalPoll(surfaceId);
      this.surfaceMeta.delete(surfaceId);
      this.lastStatus.delete(surfaceId);
      this.lastKind.delete(surfaceId);
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
    if (!isRecord(parsed)) return undefined;
    // The binding fields (kind, checkpoint_id) sit under `resume_binding` on the
    // cmux build verified here, but upstream has exposed them at the top level
    // too — accept either so a version skew doesn't strand the pane on screen
    // scraping (cmux/cmux#6285).
    const b = isRecord(parsed.resume_binding) ? parsed.resume_binding : parsed;
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
    for (const t of this.codexPollTimers.values()) clearInterval(t);
    this.codexPollTimers.clear();
    this.proc?.kill();
    this.proc = null;
    this.listeners.clear();
  }
}
