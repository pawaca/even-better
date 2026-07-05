import {
  agentList,
  paneRead,
  paneExists,
  sendInput,
  subscribe,
  typeAndSubmit,
  type AgentInfo,
  type SubscribeHandle,
} from "./herdr.js";
import { emit } from "./sse.js";
import { findSessionFile, TranscriptTail } from "./transcript.js";
import {
  classifyMenu,
  diffNewLines,
  extractResult,
  filterVolatile,
  normalizeLine,
  parseMenu,
  stripDurationTail,
  type ClassifiedMenu,
  type ParsedMenu,
} from "./parse.js";

// Human-readable stream tracing on the server console (set DEBUG_STREAM=0 to
// silence): dim = new screen content captured by the diff, green = what is
// actually sent to the glasses app, yellow = lines suppressed and why.
const STREAM_LOG = process.env.DEBUG_STREAM !== "0";
const USE_COLOR = process.stdout.isTTY === true;
function paint(code: string, s: string): string {
  return USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s;
}

const OUTPUT_WINDOW_LINES = 120;
const FLUSH_INTERVAL_MS = 400;
// pane.output_matched is edge-triggered (fires only when the first regex-
// matching line changes), so it cannot serve as an output firehose. We poll
// the visible screen instead. IMPORTANT: "visible" is the only source that
// reliably carries streaming assistant prose — herdr's "recent" region picks
// up finalized blocks (tool boxes, diffs) but skips in-place-streamed text,
// which silently loses whole messages. Fast scroll is covered by the 300ms
// cadence plus the multiset diff emitting full window replacements.
const POLL_INTERVAL_MS = 300;
// A line emitted within this window is not emitted again. Catches "flapping"
// TUI lines (e.g. "Running 1 shell command…") that toggle present/absent and
// re-render in bullet/bare variants across polls. The map is cleared on every
// turn boundary, so the window is effectively "once per turn" — long enough to
// kill chrome re-renders 40s apart, while cross-turn repeats stay visible.
const DEDUPE_WINDOW_MS = 600_000;

export type AppState = "idle" | "busy" | "awaiting";

function mapStatus(s: AgentInfo["agent_status"]): AppState {
  switch (s) {
    case "working":
      return "busy";
    case "blocked":
      return "awaiting";
    default:
      return "idle";
  }
}

/**
 * PaneBridge mirrors one herdr agent pane as an even-terminal "session":
 * subscribes to output/status events, diffs new output into text_delta
 * messages, turns blocked screens into permission_request/user_question, and
 * injects prompts/decisions back via pane.send_input.
 */
export class PaneBridge {
  readonly paneId: string;
  agent: string;
  cwd: string;
  agentSessionId: string | undefined;
  state: AppState = "idle";

  private sub: SubscribeHandle | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private lastLines: string[] = [];
  private lastFlushed = "";
  private recentlyEmitted = new Map<string, number>();
  private recentTyped = "";
  private recentTypedAt = 0;
  private pendingOut: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private turnStartMs = 0;
  private currentMenu: (ParsedMenu & ClassifiedMenu) | null = null;
  private disposed = false;

  private tail: TranscriptTail | null = null;
  private tailTimer: NodeJS.Timeout | null = null;
  private tailing = false;
  private lastProse = "";
  private lastProseBlock = "";

  constructor(info: AgentInfo) {
    this.paneId = info.pane_id;
    this.agent = info.agent;
    this.cwd = info.cwd;
    this.agentSessionId = info.agent_session?.value;
    this.state = mapStatus(info.agent_status);
  }

  get provider(): string {
    return this.agent === "codex" ? "codex" : "claude";
  }

  start(): void {
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.disposed) return;
    // Establish the output baseline BEFORE subscribing, so the first event
    // diffs against the real current screen instead of being swallowed as
    // baseline (which would drop the first response).
    try {
      const text = await this.readPane();
      this.lastLines = filterVolatile(text.split("\n"));
    } catch {
      this.lastLines = [];
    }
    if (this.disposed) return;
    this.sub = subscribe(
      [
        { type: "pane.agent_status_changed", pane_id: this.paneId },
        { type: "pane.closed", pane_id: this.paneId },
      ],
      (event, data) => this.onHerdrEvent(event, data),
      () => this.onSubClosed(),
    );
    this.startPolling();
    this.startTranscriptTail();
  }

  /** Public hook for the manager to (re)try tailing once a session id shows up. */
  startTailIfNeeded(): void {
    this.startTranscriptTail();
  }

  /** Prose comes from the agent's session transcript (jsonl) — the screen
   *  stops rendering intermediate text in long tool-heavy turns, but the
   *  transcript never misses a message. Screen polling still covers tool
   *  activity, menus, and non-claude agents. */
  private startTranscriptTail(): void {
    if (this.tailTimer || this.disposed) return;
    if (this.agent !== "claude" || !this.agentSessionId) return;
    const file = findSessionFile(this.agentSessionId);
    if (!file) return;
    try {
      this.tail = new TranscriptTail(file);
    } catch {
      return;
    }
    console.log(`[bridge ${this.paneId}] tailing transcript ${file}`);
    this.tailTimer = setInterval(() => {
      if (this.tailing || !this.tail) return;
      this.tailing = true;
      this.tail
        .readNew()
        .then((blocks) => {
          for (const block of blocks) this.onProse(block);
        })
        .catch(() => {
          // transient read error; next tick retries
        })
        .finally(() => {
          this.tailing = false;
        });
    }, 500);
  }

  private onProse(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    // remember for screen-echo suppression (rendered copies of the same prose)
    this.lastProse = (this.lastProse + "\n" + trimmed).slice(-8000);
    this.lastProseBlock = trimmed;
    if (STREAM_LOG) {
      console.log(paint("32", `► send ${this.paneId} prose ${trimmed.length} chars`));
    }
    emit(this.paneId, { type: "text_delta", text: trimmed + "\n" });
  }

  /** True when a screen line is a rendered copy of prose already delivered
   *  from the transcript (normalized: whitespace collapsed, table borders
   *  mapped back to pipes). */
  private isProseEcho(line: string): boolean {
    if (!this.lastProse) return false;
    const norm = line
      .replace(/^⏺\s*/, "")
      .replace(/[│┃]/g, "|")
      .replace(/[─═┌┬┐└┴┘├┼┤]/g, "")
      .replace(/\s+/g, "");
    if (norm.length < 6) return false;
    const hay = this.lastProse.replace(/\s+/g, "").replace(/\|/g, "|");
    return hay.includes(norm);
  }

  private startPolling(): void {
    if (this.pollTimer || this.disposed) return;
    if (process.env.DEBUG_POLL === "1") {
      console.log(`[poll ${this.paneId}] polling started`);
    }
    this.pollTimer = setInterval(() => {
      if (this.polling) return;
      this.polling = true;
      this.readPane()
        .then((text) => this.onOutput(text))
        .catch((err: Error) => {
          if (process.env.DEBUG_POLL === "1") {
            console.log(`[poll ${this.paneId}] read failed: ${err.message}`);
          }
        })
        .finally(() => {
          this.polling = false;
        });
    }, POLL_INTERVAL_MS);
  }

  /** Read the pane's visible screen — the one source that carries everything
   *  the user sees, including streaming prose (see POLL_INTERVAL_MS note). */
  private async readPane(): Promise<string> {
    return paneRead(this.paneId, "visible", OUTPUT_WINDOW_LINES);
  }

  private onSubClosed(): void {
    this.sub = null;
    if (this.disposed) return;
    // herdr may have restarted; retry while the pane still exists.
    setTimeout(() => {
      void paneExists(this.paneId).then((exists) => {
        if (exists) this.connect();
        else this.dispose();
      });
    }, 2000);
  }

  private onHerdrEvent(event: string, data: Record<string, unknown>): void {
    if (event === "pane.closed") {
      this.dispose();
      return;
    }
    if (event === "pane.agent_status_changed") {
      const raw =
        (data.state as string | undefined) ??
        (data.agent_status as string | undefined) ??
        "unknown";
      this.onStatus(raw);
      return;
    }
  }

  // ── output streaming ─────────────────────────────────

  private onOutput(text: string): void {
    const lines = filterVolatile(text.split("\n")).map(normalizeLine);
    if (this.lastLines.length === 0) {
      // No baseline (e.g. pane was blank at startup): everything is new.
      this.lastLines = lines;
      if (lines.some((l) => l.trim())) {
        this.pendingOut.push(...lines);
        if (!this.flushTimer) {
          this.flushTimer = setTimeout(() => this.flushOutput(), FLUSH_INTERVAL_MS);
        }
      }
      return;
    }
    const added = diffNewLines(this.lastLines, lines);
    this.lastLines = lines;
    if (added.length === 0) return;
    if (STREAM_LOG) {
      console.log(paint("2", `┌ capture ${this.paneId} +${added.length} line(s)`));
      for (const l of added) console.log(paint("2", `│ ${l}`));
    }
    this.pendingOut.push(...added);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushOutput(), FLUSH_INTERVAL_MS);
    }
  }

  /** True when a line is the pane's echo of text we just typed (the prompt
   *  box renders it, wrapped; the app already displays user_prompt itself). */
  private isTypedEcho(line: string): boolean {
    if (!this.recentTyped || Date.now() - this.recentTypedAt > 120_000) return false;
    const norm = line.replace(/\s+/g, "");
    return norm.length >= 4 && this.recentTyped.includes(norm);
  }

  private flushOutput(): void {
    this.flushTimer = null;
    if (this.pendingOut.length === 0) return;
    const out: string[] = [];
    for (const line of this.pendingOut) {
      const t = line.trim();
      if (!t) continue;
      if (this.isTypedEcho(line)) {
        if (STREAM_LOG) console.log(paint("33", `✂ drop(echo) ${this.paneId}: ${t.slice(0, 90)}`));
        continue;
      }
      if (this.isProseEcho(line)) {
        if (STREAM_LOG) console.log(paint("33", `✂ drop(prose-echo) ${this.paneId}: ${t.slice(0, 90)}`));
        continue;
      }
      // Dedupe key ignores the leading "⏺" bullet (claude renders the same
      // status line both standalone and bullet-prefixed) and any trailing
      // elapsed-time suffix (in-progress commands re-render every second as
      // "… (4s)" → "… (5s)" on whichever wrapped row the suffix lands).
      const key = stripDurationTail(t.replace(/^⏺\s*/, ""));
      const emittedAt = this.recentlyEmitted.get(key);
      if (emittedAt !== undefined && Date.now() - emittedAt < DEDUPE_WINDOW_MS) {
        if (STREAM_LOG) console.log(paint("33", `✂ drop(dupe) ${this.paneId}: ${t.slice(0, 90)}`));
        continue;
      }
      this.recentlyEmitted.set(key, Date.now());
      out.push(line);
    }
    // prune expired dedupe entries so the map stays bounded
    if (this.recentlyEmitted.size > 500) {
      const cutoff = Date.now() - DEDUPE_WINDOW_MS;
      for (const [k, ts] of this.recentlyEmitted) {
        if (ts < cutoff) this.recentlyEmitted.delete(k);
      }
    }
    this.pendingOut = [];
    if (out.length === 0) return;
    const text = out.join("\n");
    if (text === this.lastFlushed) return; // safety net against re-emits
    this.lastFlushed = text;
    if (STREAM_LOG) {
      console.log(paint("32", `► send ${this.paneId} text_delta ${out.length} line(s)`));
      for (const l of out) console.log(paint("32", `│ ${l}`));
    }
    emit(this.paneId, { type: "text_delta", text: text + "\n" });
  }

  // ── status transitions ───────────────────────────────

  private onStatus(raw: string): void {
    const prev = this.state;
    const next = mapStatus(raw as AgentInfo["agent_status"]);
    console.log(`[bridge ${this.paneId}] status ${prev} -> ${next} (herdr: ${raw})`);
    this.state = next;

    if (next === "busy" && prev !== "busy") {
      if (!this.turnStartMs) this.turnStartMs = Date.now();
      this.recentlyEmitted.clear(); // new turn — allow repeats of past content
      emit(this.paneId, { type: "status", state: "busy", sessionId: this.paneId });
    }

    if (next === "awaiting" && prev !== "awaiting") {
      void this.emitBlockedMenu();
    }

    if (next === "idle" && prev !== "idle") {
      this.flushOutput();
      void this.emitTurnResult();
    }
  }

  private async emitBlockedMenu(): Promise<void> {
    let screen = "";
    try {
      screen = await paneRead(this.paneId, "visible", 45);
    } catch {
      return;
    }
    const menu = parseMenu(screen);
    if (!menu) {
      emit(this.paneId, {
        type: "notification",
        title: "Agent blocked",
        message: "Agent is waiting for input in the terminal",
      });
      return;
    }
    const classified = classifyMenu(menu);
    this.currentMenu = { ...menu, ...classified };

    if (classified.kind === "permission") {
      const options: { text: string; key: string }[] = [
        { text: classified.allow?.label ?? "Yes", key: "allow" },
      ];
      if (classified.allowAlways) {
        options.push({ text: classified.allowAlways.label, key: "allowAlways" });
      }
      options.push({ text: classified.deny?.label ?? "No", key: "deny" });
      emit(this.paneId, {
        type: "permission_request",
        toolName: this.agent,
        description: menu.title || "Permission required",
        detail: menu.title,
        toolUseId: `${this.paneId}-${Date.now()}`,
        options,
        suggestions: null,
      });
    } else {
      emit(this.paneId, {
        type: "user_question",
        questions: [
          {
            question: menu.title || "Choose an option",
            header: "",
            options: menu.options.map((o) => ({
              label: o.label,
              description: "",
              preview: "",
            })),
          },
        ],
        toolUseId: `${this.paneId}-${Date.now()}`,
      });
    }
  }

  private async emitTurnResult(): Promise<void> {
    emit(this.paneId, { type: "status", state: "idle", sessionId: this.paneId });
    let text = "";
    if (this.lastProseBlock) {
      // the transcript's final assistant text is the authoritative answer
      text = this.lastProseBlock;
      this.lastProseBlock = "";
    } else {
      try {
        const raw = await this.readPane();
        text = extractResult(raw.split("\n"));
      } catch {
        // pane may be gone; result stays empty
      }
    }
    const durationMs = this.turnStartMs ? Date.now() - this.turnStartMs : 0;
    this.turnStartMs = 0;
    emit(this.paneId, {
      type: "result",
      success: true,
      text,
      sessionId: this.paneId,
      costUsd: 0,
      provider: this.provider,
      turns: 0,
      durationMs,
      inputTokens: 0,
      outputTokens: 0,
    });
  }

  // ── inbound from the app ─────────────────────────────

  async prompt(text: string): Promise<void> {
    emit(this.paneId, { type: "user_prompt", text });
    this.recentlyEmitted.clear(); // new turn — allow repeats of past content
    this.recentTyped = text.replace(/\s+/g, "");
    this.recentTypedAt = Date.now();
    await typeAndSubmit(this.paneId, text);
    if (this.state !== "busy") {
      this.turnStartMs = Date.now();
      this.state = "busy";
      emit(this.paneId, { type: "status", state: "busy", sessionId: this.paneId });
    }
  }

  async respondPermission(decision: string): Promise<void> {
    const menu = this.currentMenu;
    this.currentMenu = null;
    let summary = "";
    try {
      if (decision === "allow" && menu?.allow) {
        summary = menu.allow.label;
        await sendInput(this.paneId, menu.allow.digit);
      } else if (decision === "allowAlways" && menu?.allowAlways) {
        summary = menu.allowAlways.label;
        await sendInput(this.paneId, menu.allowAlways.digit);
      } else if (decision === "allow" || decision === "allowAlways") {
        summary = "Yes";
        await sendInput(this.paneId, "", ["Enter"]);
      } else if (menu?.deny) {
        summary = menu.deny.label;
        await sendInput(this.paneId, menu.deny.digit);
      } else {
        summary = "No";
        await sendInput(this.paneId, "", ["Escape"]);
      }
    } catch (err) {
      console.error(`[bridge ${this.paneId}] respondPermission failed:`, err);
    }
    emit(this.paneId, {
      type: "permission_result",
      toolName: this.agent,
      summary,
      decision: decision === "allowAlways" ? "always" : decision === "allow" ? "allowed" : "denied",
    });
  }

  async respondQuestion(answer: string): Promise<void> {
    const menu = this.currentMenu;
    this.currentMenu = null;
    // The app may send a plain label or a JSON map of {question: label}.
    let label = answer;
    try {
      const parsed = JSON.parse(answer) as Record<string, string>;
      const first = Object.values(parsed)[0];
      if (typeof first === "string") label = first;
    } catch {
      // plain string
    }
    const norm = label.trim().toLowerCase();
    const match = menu?.options.find(
      (o) =>
        o.label.toLowerCase() === norm ||
        o.label.toLowerCase().startsWith(norm) ||
        norm.startsWith(o.label.toLowerCase()),
    );
    try {
      if (match) {
        await sendInput(this.paneId, match.digit);
      } else {
        // Free-text answer: type it and submit.
        this.recentTyped = label.replace(/\s+/g, "");
        this.recentTypedAt = Date.now();
        await typeAndSubmit(this.paneId, label);
      }
    } catch (err) {
      console.error(`[bridge ${this.paneId}] respondQuestion failed:`, err);
    }
    emit(this.paneId, { type: "question_answer", answers: { answer: label } });
  }

  async interrupt(): Promise<void> {
    await sendInput(this.paneId, "", ["Escape"]);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.tailTimer) clearInterval(this.tailTimer);
    this.sub?.close();
    console.log(`[bridge ${this.paneId}] disposed`);
  }
}

// ── manager ────────────────────────────────────────────

const bridges = new Map<string, PaneBridge>();

/** Reconcile bridges with herdr's current agent list; returns the list. */
export async function refreshAgents(): Promise<AgentInfo[]> {
  const agents = await agentList();
  const seen = new Set<string>();
  for (const info of agents) {
    seen.add(info.pane_id);
    const existing = bridges.get(info.pane_id);
    if (existing) {
      existing.agent = info.agent;
      existing.cwd = info.cwd;
      // the agent session may only become known after the first prompt —
      // pick up the transcript tail as soon as the id appears
      if (info.agent_session?.value && !existing.agentSessionId) {
        existing.agentSessionId = info.agent_session.value;
        existing.startTailIfNeeded();
      }
    } else {
      const b = new PaneBridge(info);
      bridges.set(info.pane_id, b);
      b.start();
      console.log(`[bridge] tracking ${info.agent} pane ${info.pane_id} (${info.cwd})`);
    }
  }
  for (const [paneId, b] of bridges) {
    if (!seen.has(paneId)) {
      b.dispose();
      bridges.delete(paneId);
    }
  }
  return agents;
}

export function getBridge(paneId: string): PaneBridge | undefined {
  return bridges.get(paneId);
}

export async function getOrCreateBridge(paneId: string): Promise<PaneBridge | undefined> {
  const existing = bridges.get(paneId);
  if (existing) return existing;
  await refreshAgents();
  return bridges.get(paneId);
}

export function focusedOrFirstBridge(agents: AgentInfo[]): PaneBridge | undefined {
  const focused = agents.find((a) => a.focused);
  const target = focused ?? agents[0];
  return target ? bridges.get(target.pane_id) : undefined;
}

export function disposeAll(): void {
  for (const b of bridges.values()) b.dispose();
  bridges.clear();
}
