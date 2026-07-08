// The Multiplexer seam. A Multiplexer is "pane I/O for a terminal that hosts
// coding agents": discover panes, watch each pane's agent status, read its
// screen, inject keys, and surface the agent's session id so the bridge can tail
// the structured transcript. herdr is one implementation; cmux is the second —
// their existence is what earns this abstraction (see docs/ARCHITECTURE.md).
//
// Everything downstream (PaneBridge, timelines, sink) speaks these neutral
// types, never a backend's wire vocabulary. Status is normalized here so the
// bridge's turn state machine is identical across backends; herdr's rule-based
// `explain` is an OPTIONAL capability a backend may omit (cmux does), in which
// case blocked menus fall back to screen parsing.

/** Normalized agent status. `closed` means the pane/surface is gone. */
export type PaneStatus = "idle" | "busy" | "awaiting" | "closed";

/** One agent pane, provider-neutral. `paneId` is the backend's stable handle
 *  (herdr pane id, cmux surface uuid). `sessionId` is the agent's session id
 *  with any backend prefix stripped, present once the agent has one. */
export interface PaneInfo {
  paneId: string;
  agent: string; // "claude" | "codex" | other
  cwd: string;
  focused: boolean;
  status: PaneStatus;
  sessionId?: string;
}

/** Why a pane is blocked, when the backend can classify it (herdr only). */
export interface Explanation {
  rule?: string;
  state?: string;
  evidence?: string;
}

export interface StatusSub {
  close(): void;
}

export interface Multiplexer {
  readonly name: string;
  /** Every agent pane currently known to the backend. */
  listPanes(): Promise<PaneInfo[]>;
  /** Push normalized status transitions for one pane until `close()`. `session`
   *  carries the agent's session id when the backend learns it from the same
   *  event (herdr's status event, cmux's SessionStart-refreshed maps), so the
   *  bridge upgrades to the transcript without polling; undefined until known.
   *  onClose fires when the underlying stream drops (caller decides whether to
   *  retry). */
  watchStatus(
    paneId: string,
    onStatus: (s: PaneStatus, session?: string) => void,
    onClose: (err?: Error) => void,
  ): StatusSub;
  /** The pane's visible screen (viewport), up to `lines` lines. */
  read(paneId: string, lines: number): Promise<string>;
  /** Type `text`, then press `keys` (e.g. ["Enter"]) as one delivery. */
  send(paneId: string, text: string, keys?: string[]): Promise<void>;
  /** The agent's session id, prefix-stripped, or undefined if not yet known. */
  sessionId(paneId: string): Promise<string | undefined>;
  exists(paneId: string): Promise<boolean>;
  /** OPTIONAL: backend classification of a blocked pane. herdr implements it;
   *  a backend without a classifier omits it and the caller reads the screen. */
  explain?(paneId: string): Promise<Explanation>;
  /** OPTIONAL: the kind of interactive blocker currently open, when the backend
   *  learns it from the event that opened it (cmux). Lets the caller render a
   *  question as a question even if screen parsing is inconclusive. */
  interactionKind?(paneId: string): "permission" | "question" | undefined;
  /** OPTIONAL: release long-lived resources (e.g. cmux's event-stream child) on
   *  process shutdown. Backends with none (herdr) omit it. */
  dispose?(): void;
}

// ── active multiplexer selection ───────────────────────
// The process runs one Multiplexer, chosen at boot (index.ts) and read
// everywhere via getMux(). Kept here (not in a backend module) so neither
// backend imports the other.

let active: Multiplexer | null = null;

export function setMux(m: Multiplexer): void {
  active = m;
}

export function getMux(): Multiplexer {
  if (!active) throw new Error("multiplexer not selected — call setMux() at startup");
  return active;
}

/**
 * Type text into a pane and submit it with a real Enter, in two separate sends.
 * Sending text+Enter together makes TUI line editors (claude prompt box, zsh
 * ZLE) treat the Enter as part of the paste, leaving the text unsubmitted.
 * Between the two we wait (bounded) until the pane visibly echoes the text.
 * Shared by every backend because it is expressed purely in send()/read().
 */
export async function typeAndSubmit(mux: Multiplexer, paneId: string, text: string): Promise<void> {
  await mux.send(paneId, text);
  const probe = text.split("\n")[0].slice(0, 12).trim();
  if (probe) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        const visible = await mux.read(paneId, 40);
        if (visible.includes(probe)) break;
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await mux.send(paneId, "", ["Enter"]);
}
