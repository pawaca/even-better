import {
  agentList,
  paneRead,
  paneExists,
  paneSessionId,
  sendInput,
  subscribe,
  typeAndSubmit,
  type AgentInfo,
  type SubscribeHandle,
} from "./herdr.js";
import { emit } from "./sse.js";
import {
  findSessionFile,
  summarizeTool,
  TranscriptTail,
  type TranscriptEvent,
} from "./transcript.js";
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
  private sessionProbeTimer: NodeJS.Timeout | null = null;
  private lastProseBlock = "";
  private pendingTools = new Map<string, { name: string; input: Record<string, unknown> }>();
  private turnInputTokens = 0;
  private turnOutputTokens = 0;

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
    // Transcript tail is the primary content channel; screen polling is the
    // fallback for panes without a readable transcript (codex, plain agents).
    this.startTranscriptTail();
    if (!this.tail) {
      this.startPolling();
      this.startSessionProbe();
    }
  }

  /** A fresh claude pane has no session id until its first prompt lands.
   *  Probe herdr every 2s so the bridge switches from screen fallback to the
   *  transcript as soon as the session exists. */
  private startSessionProbe(): void {
    if (this.sessionProbeTimer || this.tail || this.disposed) return;
    if (this.agent !== "claude") return;
    this.sessionProbeTimer = setInterval(() => {
      if (this.tail || this.disposed) {
        if (this.sessionProbeTimer) clearInterval(this.sessionProbeTimer);
        this.sessionProbeTimer = null;
        return;
      }
      void paneSessionId(this.paneId)
        .then((id) => {
          if (!id) return;
          this.agentSessionId = id;
          this.startTranscriptTail();
          if (this.tail) {
            this.stopPolling();
            if (this.sessionProbeTimer) clearInterval(this.sessionProbeTimer);
            this.sessionProbeTimer = null;
          }
        })
        .catch(() => {});
    }, 2000);
  }

  /** Public hook for the manager to (re)try tailing once a session id shows up. */
  startTailIfNeeded(): void {
    this.startTranscriptTail();
    if (this.tail) this.stopPolling();
  }

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
        .then((events) => {
          for (const ev of events) this.onTranscriptEvent(ev);
        })
        .catch(() => {
          // transient read error; next tick retries
        })
        .finally(() => {
          this.tailing = false;
        });
    }, 500);
  }

  private onTranscriptEvent(ev: TranscriptEvent): void {
    if (ev.usage) {
      this.turnInputTokens += ev.usage.input;
      this.turnOutputTokens += ev.usage.output;
    }
    switch (ev.kind) {
      case "user_prompt": {
        const text = (ev.text ?? "").trim();
        if (!text) return;
        // prompts we injected ourselves were already emitted by prompt()
        const norm = text.replace(/\s+/g, "");
        if (
          this.recentTyped &&
          Date.now() - this.recentTypedAt < 120_000 &&
          norm === this.recentTyped
        ) {
          return;
        }
        if (STREAM_LOG) console.log(paint("36", `► send ${this.paneId} user_prompt(terminal) ${text.slice(0, 60)}`));
        emit(this.paneId, { type: "user_prompt", text });
        return;
      }
      case "text": {
        const text = (ev.text ?? "").trim();
        if (!text) return;
        this.lastProseBlock = text;
        if (STREAM_LOG) console.log(paint("32", `► send ${this.paneId} text ${text.length} chars`));
        emit(this.paneId, { type: "text_delta", text: text + "\n" });
        return;
      }
      case "tool_use": {
        if (!ev.toolId || !ev.toolName) return;
        this.pendingTools.set(ev.toolId, {
          name: ev.toolName,
          input: ev.input ?? {},
        });
        if (this.pendingTools.size > 100) {
          const first = this.pendingTools.keys().next().value;
          if (first) this.pendingTools.delete(first);
        }
        const summary = summarizeTool(ev.toolName, ev.input ?? {});
        if (STREAM_LOG) console.log(paint("32", `► send ${this.paneId} tool_start ${summary.slice(0, 80)}`));
        emit(this.paneId, { type: "tool_start", name: ev.toolName, toolId: ev.toolId });
        emit(this.paneId, { type: "text_delta", text: `⏺ ${summary}\n` });
        return;
      }
      case "tool_result": {
        if (!ev.toolId) return;
        const pending = this.pendingTools.get(ev.toolId);
        if (!pending) return;
        this.pendingTools.delete(ev.toolId);
        const output = (ev.text ?? "").slice(0, 1500);
        emit(this.paneId, {
          type: "tool_end",
          name: pending.name,
          toolId: ev.toolId,
          summary: summarizeTool(pending.name, pending.input),
          detail: { input: pending.input, output },
        });
        return;
      }
    }
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
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
      this.turnInputTokens = 0;
      this.turnOutputTokens = 0;
      this.lastProseBlock = ""; // don't let a prose-less turn reuse old text
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
    if (this.tail) {
      // The herdr idle event can beat the 500ms tail tick: the final text
      // block may not have been read from the transcript yet. Give the tail
      // two ticks to drain before snapshotting the answer.
      await new Promise((r) => setTimeout(r, 1100));
    }
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
      inputTokens: this.turnInputTokens,
      outputTokens: this.turnOutputTokens,
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
    if (this.sessionProbeTimer) clearInterval(this.sessionProbeTimer);
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
