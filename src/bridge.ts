import {
  agentExplain,
  agentList,
  paneRead,
  paneExists,
  paneSessionId,
  sendInput,
  subscribe,
  typeAndSubmit,
  type AgentExplain,
  type AgentInfo,
  type SubscribeHandle,
} from "./herdr.js";
import { emit } from "./sse.js";
import { logEvent } from "./log.js";
import type { AgentEvent, Timeline } from "./spine.js";
import { findSessionFile, summarizeTool, TranscriptTimeline } from "./transcript.js";
import { ScreenTimeline } from "./screen-timeline.js";
import { renderForGlasses } from "./render.js";
import {
  classifyMenu,
  extractResult,
  parseMenu,
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
// Cadence at which the active Timeline is polled. The transcript tail (cheap
// stat) and the screen scrape (a socket read of ≤120 lines) both tolerate this.
const POLL_INTERVAL_MS = 300;
// Text is streamed out a few characters at a time on this cadence, so it
// appears to type in smoothly instead of arriving in one burst. The per-tick
// character count adapts to the backlog (see streamTick) so long answers still
// finish in a bounded time. Tune STREAM_TICK_MS for overall speed.
const STREAM_TICK_MS = 100;
// How long herdr must stay "idle" before we treat a turn as ended. herdr flips
// to idle transiently between tool calls (prompt box flashes), so committing
// immediately blanks the thinking indicator and fires a spurious result. Any
// busy signal or content activity within this window cancels the pending idle.
const IDLE_GRACE_MS = 3500;

interface TodoItem {
  status?: string;
  content?: string;
  activeForm?: string;
}

/** Map a TodoWrite tool input to the app's task_progress widget fields. */
export function todoProgress(
  input: Record<string, unknown>,
): { completed: number; total: number; current: string } | null {
  const todos = Array.isArray(input.todos) ? (input.todos as TodoItem[]) : [];
  const total = todos.length;
  if (!total) return null;
  const completed = todos.filter((t) => t?.status === "completed").length;
  const active = todos.find((t) => t?.status === "in_progress");
  const current = active
    ? (active.content ?? active.activeForm ?? "")
    : completed === total
      ? "All done"
      : "";
  return { completed, total, current };
}

// A text item streams out `chars` from `pos`; an event item is emitted whole.
type StreamItem = { chars: string[]; pos: number } | { event: object };

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
  // The active event source. `timeline` is what the poll loop drives; `screen`
  // aliases it only when it is a ScreenTimeline (for noteTyped/resetTurn).
  private timeline: Timeline | null = null;
  private screen: ScreenTimeline | null = null;
  private onTranscript = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private sessionProbeTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  private recentTyped = ""; // our injected prompt, to suppress its echo in the timeline
  private recentTypedAt = 0;
  private turnStartMs = 0;
  private currentMenu: (ParsedMenu & ClassifiedMenu) | null = null;
  private disposed = false;

  private lastProseBlock = "";
  private pendingTools = new Map<string, { name: string; input: Record<string, unknown> }>();
  private turnInputTokens = 0;
  private turnOutputTokens = 0;

  // Streaming output queue: text items type out a few characters per tick;
  // event items (tool_start) are released whole in order. Widgets
  // (status/stats/task_progress) bypass this; result/idle wait for it to drain.
  private streamQueue: StreamItem[] = [];
  private pacer: NodeJS.Timeout | null = null;

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
    this.sub = subscribe(
      [
        { type: "pane.agent_status_changed", pane_id: this.paneId },
        { type: "pane.closed", pane_id: this.paneId },
      ],
      (event, data) => this.onHerdrEvent(event, data),
      () => this.onSubClosed(),
    );
    // A pane can already be blocked when the bridge discovers it (e.g. trust
    // dialog on startup) — no transition event will fire, so emit the menu now.
    if (this.state === "awaiting") void this.emitBlockedMenu();
    this.selectTimeline();
    this.startPolling();
    if (!this.onTranscript) this.startSessionProbe();
  }

  /** Pick the content source: the Claude transcript when available (structured,
   *  lossless), else a ScreenTimeline fallback that scrapes the TUI. */
  private selectTimeline(): void {
    if (this.agent === "claude" && this.agentSessionId) {
      const file = findSessionFile(this.agentSessionId);
      if (file) {
        this.timeline = new TranscriptTimeline(file);
        this.screen = null;
        this.onTranscript = true;
        console.log(`[bridge ${this.paneId}] tailing transcript ${file}`);
        return;
      }
    }
    this.screen = new ScreenTimeline({
      read: () => this.readPane(),
      windowLines: OUTPUT_WINDOW_LINES,
      trace: STREAM_LOG
        ? (kind, line) => {
            const color = kind === "capture" ? "2" : kind === "send" ? "32" : "33";
            const prefix = kind === "capture" ? "┌ capture" : kind === "send" ? "► send" : "✂ drop";
            console.log(paint(color, `${prefix} ${this.paneId} ${line}`));
          }
        : undefined,
    });
    this.timeline = this.screen;
    this.onTranscript = false;
  }

  /** A fresh claude pane has no session id until its first prompt lands. Probe
   *  herdr every 2s so the bridge upgrades from the screen fallback to the
   *  transcript as soon as the session exists. */
  private startSessionProbe(): void {
    if (this.sessionProbeTimer || this.onTranscript || this.disposed) return;
    if (this.agent !== "claude") return;
    this.sessionProbeTimer = setInterval(() => {
      if (this.onTranscript || this.disposed) {
        this.clearProbe();
        return;
      }
      void paneSessionId(this.paneId)
        .then((id) => {
          if (!id || this.onTranscript) return;
          const file = findSessionFile(id);
          if (!file) return;
          this.agentSessionId = id;
          this.screen?.dispose();
          this.timeline = new TranscriptTimeline(file);
          this.screen = null;
          this.onTranscript = true;
          console.log(`[bridge ${this.paneId}] upgraded to transcript ${file}`);
          this.clearProbe();
        })
        .catch(() => {});
    }, 2000);
  }

  private clearProbe(): void {
    if (this.sessionProbeTimer) {
      clearInterval(this.sessionProbeTimer);
      this.sessionProbeTimer = null;
    }
  }

  /** Queue text to type out gradually. Split by code point so a surrogate pair
   *  (emoji) is never cut across two frames. */
  private streamText(text: string): void {
    if (!text) return;
    this.streamQueue.push({ chars: [...text], pos: 0 });
    if (!this.pacer) this.streamTick();
  }

  /** Queue a whole event (e.g. tool_start) to release in order with the text. */
  private streamEvent(msg: object): void {
    this.streamQueue.push({ event: msg });
    if (!this.pacer) this.streamTick();
  }

  private pendingChars(): number {
    let n = 0;
    for (const it of this.streamQueue) if ("chars" in it) n += it.chars.length - it.pos;
    return n;
  }

  private streamTick(): void {
    const head = this.streamQueue[0];
    if (!head) {
      this.pacer = null;
      return;
    }
    if ("event" in head) {
      emit(this.paneId, head.event);
      this.streamQueue.shift();
    } else {
      // Chars per tick scale with the backlog so a long answer stays bounded
      // (~10s) while a short one types gently; never split by less than 4.
      const n = Math.min(30, Math.max(4, Math.ceil(this.pendingChars() / 120)));
      const slice = head.chars.slice(head.pos, head.pos + n).join("");
      head.pos += n;
      emit(this.paneId, { type: "text_delta", text: slice });
      if (head.pos >= head.chars.length) this.streamQueue.shift();
    }
    this.pacer = setTimeout(() => this.streamTick(), STREAM_TICK_MS);
  }

  /** Wait until the stream queue has fully drained (before result/idle). */
  private async drainStream(): Promise<void> {
    while (this.streamQueue.length > 0 || this.pacer) {
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  private clearStream(): void {
    this.streamQueue = [];
    if (this.pacer) {
      clearTimeout(this.pacer);
      this.pacer = null;
    }
  }

  /** While a turn runs, push a live elapsed/token counter every 10s. The app
   *  renders `running_stats` as a single widget it overwrites in place. */
  private startStats(): void {
    this.stopStats();
    this.statsTimer = setInterval(() => {
      if (this.state !== "busy") {
        this.stopStats();
        return;
      }
      emit(this.paneId, {
        type: "running_stats",
        durationMs: this.turnStartMs ? Date.now() - this.turnStartMs : 0,
        inputTokens: this.turnInputTokens,
        outputTokens: this.turnOutputTokens,
      });
    }, 10_000);
  }

  private stopStats(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  /** Manager hook: a session id became known (e.g. from agent.list). Upgrade to
   *  the transcript if we are still on the screen fallback. */
  noteSessionId(id: string): void {
    if (this.onTranscript || this.disposed || this.agent !== "claude") return;
    const file = findSessionFile(id);
    if (!file) return;
    this.agentSessionId = id;
    this.screen?.dispose();
    this.timeline = new TranscriptTimeline(file);
    this.screen = null;
    this.onTranscript = true;
    this.clearProbe();
    console.log(`[bridge ${this.paneId}] upgraded to transcript ${file}`);
  }

  private startPolling(): void {
    if (this.pollTimer || this.disposed) return;
    this.pollTimer = setInterval(() => {
      const tl = this.timeline;
      if (this.polling || !tl) return;
      this.polling = true;
      tl.poll()
        .then((events) => {
          for (const ev of events) this.onAgentEvent(ev);
        })
        .catch(() => {
          // transient read/parse error; next tick retries
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

  /** Map one provider-neutral AgentEvent to the app wire protocol. Provider-,
   *  source-, and heuristic-agnostic — a `say` is a `say` whether it came from
   *  the jsonl or a scraped screen. */
  private onAgentEvent(e: AgentEvent): void {
    // New content while an idle is pending means the agent is still working
    // (herdr's idle was a between-tools blip); cancel it so the indicator holds.
    if (this.idleTimer && (e.t === "say" || e.t === "tool" || e.t === "toolResult")) {
      this.cancelIdle();
    }
    switch (e.t) {
      case "prompt": {
        const text = e.text.trim();
        if (!text) return;
        // suppress the timeline's record of a prompt we injected (already
        // emitted by prompt()); terminal-typed prompts fall through.
        const norm = text.replace(/\s+/g, "");
        if (this.recentTyped && Date.now() - this.recentTypedAt < 120_000 && norm === this.recentTyped) {
          return;
        }
        emit(this.paneId, { type: "user_prompt", text });
        return;
      }
      case "say": {
        if (e.usage) {
          this.turnInputTokens += e.usage.input;
          this.turnOutputTokens += e.usage.output;
        }
        const text = e.text.trim();
        if (!text) return;
        this.lastProseBlock = text; // keep the raw text for the turn result
        // Stream the whole rendered block character-by-character (see
        // streamText) so it types in smoothly with no artificial line breaks;
        // the trailing "\n" only separates this block from the next.
        this.streamText(renderForGlasses(text) + "\n");
        return;
      }
      case "tool": {
        if (e.usage) {
          this.turnInputTokens += e.usage.input;
          this.turnOutputTokens += e.usage.output;
        }
        // TodoWrite drives the app's live progress bar, not a tool bubble.
        if (e.name === "TodoWrite") {
          const progress = todoProgress(e.input);
          if (progress) emit(this.paneId, { type: "task_progress", ...progress });
          return; // no start/end correlation for todos
        }
        // The app renders a tool as a start→end bubble keyed by toolId, and it
        // styles both with its own prefix — so we work with that rather than
        // against it. tool_start carries the name, a readable summary, and the
        // full input params; tool_end adds the output. Streamed so it stays in
        // order with the surrounding text.
        this.pendingTools.set(e.id, { name: e.name, input: e.input });
        if (this.pendingTools.size > 100) {
          const first = this.pendingTools.keys().next().value;
          if (first) this.pendingTools.delete(first);
        }
        this.streamEvent({
          type: "tool_start",
          name: e.name,
          toolId: e.id,
          summary: summarizeTool(e.name, e.input),
          detail: { input: e.input },
        });
        return;
      }
      case "toolResult": {
        const pending = this.pendingTools.get(e.id);
        if (!pending) return;
        this.pendingTools.delete(e.id);
        this.streamEvent({
          type: "tool_end",
          name: pending.name,
          toolId: e.id,
          summary: summarizeTool(pending.name, pending.input),
          detail: { input: pending.input, output: e.output.slice(0, 1500) },
        });
        return;
      }
    }
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

  // ── status transitions ───────────────────────────────

  private onStatus(raw: string): void {
    const next = mapStatus(raw as AgentInfo["agent_status"]);
    console.log(`[bridge ${this.paneId}] status ${this.state} -> ${next} (herdr: ${raw})`);

    if (next === "busy") {
      // Any working signal cancels a pending idle — that idle was just a blip
      // between tool operations, not a real turn end.
      this.cancelIdle();
      if (this.state !== "busy") this.enterBusyTurn();
      return;
    }

    if (next === "awaiting") {
      this.cancelIdle();
      if (this.state !== "awaiting") {
        this.state = "awaiting";
        void this.emitBlockedMenu();
      }
      return;
    }

    // next === "idle": DEBOUNCE. herdr reports a transient idle whenever the
    // pane isn't showing the working spinner (e.g. its prompt box flashes
    // between tool calls), which would otherwise blank the thinking indicator
    // and fire a spurious result mid-turn. Only commit the turn end after idle
    // persists for IDLE_GRACE_MS; a busy signal or content activity cancels it.
    if (this.state === "idle" || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.state = "idle";
      this.stopStats();
      void this.emitTurnResult();
    }, IDLE_GRACE_MS);
  }

  private enterBusyTurn(): void {
    if (!this.turnStartMs) this.turnStartMs = Date.now();
    this.screen?.resetTurn(); // new turn — allow repeats of past content
    this.clearStream(); // drop any stale content from a prior turn
    this.turnInputTokens = 0;
    this.turnOutputTokens = 0;
    this.lastProseBlock = ""; // don't let a prose-less turn reuse old text
    this.state = "busy";
    emit(this.paneId, { type: "status", state: "busy", sessionId: this.paneId });
    this.startStats();
  }

  private cancelIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async emitBlockedMenu(): Promise<void> {
    // Give the TUI a beat to finish painting the menu before reading it.
    await new Promise((r) => setTimeout(r, 400));
    if (this.state !== "awaiting") return; // resolved in the meantime

    // Three sources, each for what it is best at:
    //  - herdr agent.explain → which detection rule fired (menu TYPE)
    //  - transcript pendingTools → which tool is awaiting approval (CONTENT)
    //  - screen parse → the option labels/digits (CHOICES)
    let screen = "";
    try {
      screen = await paneRead(this.paneId, "visible", 45);
    } catch {
      return;
    }
    let explain: AgentExplain = {};
    try {
      explain = await agentExplain(this.paneId);
    } catch {
      // explain unavailable — fall back to screen classification alone
    }
    const menu = parseMenu(screen);
    const classified = menu ? classifyMenu(menu) : null;
    const pendingTool = [...this.pendingTools.values()].pop();

    logEvent("diag", this.paneId, {
      blocked: {
        rule: explain.rule ?? null,
        evidence: explain.evidence?.slice(0, 200) ?? null,
        parsedOptions: menu?.options ?? null,
        parsedTitle: menu?.title ?? null,
        classified: classified?.kind ?? null,
        pendingTool: pendingTool ? summarizeTool(pendingTool.name, pendingTool.input) : null,
        screenTail: screen.slice(-1200),
      },
    });

    // Menu type: trust herdr's rule id first, screen classification second.
    const rule = explain.rule ?? "";
    const kind: "permission" | "question" =
      /form|workflow/.test(rule)
        ? "question"
        : /permission|blocker/.test(rule)
          ? "permission"
          : (classified?.kind ?? "permission");

    if (kind === "question") {
      if (!menu) {
        emit(this.paneId, {
          type: "notification",
          title: "Agent waiting",
          message: "An unparseable form is open — please respond in the terminal",
        });
        return;
      }
      this.currentMenu = { ...menu, ...classifyMenu(menu) };
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
      return;
    }

    // Permission: options from the parsed menu, or synthesized standard ones
    // (claude permission menus are highly regular: 1=Yes … last=No/Esc).
    const effective: ParsedMenu & ClassifiedMenu =
      menu && classified?.kind === "permission"
        ? { ...menu, ...classified }
        : {
            title: "",
            options: [
              { digit: "1", label: "Yes" },
              { digit: "", label: "No (esc)" },
            ],
            kind: "permission",
            allow: { digit: "1", label: "Yes" },
            deny: { digit: "", label: "No" },
          };
    this.currentMenu = effective;

    const description = pendingTool
      ? summarizeTool(pendingTool.name, pendingTool.input)
      : effective.title || "Permission required";
    const options: { text: string; key: string }[] = [
      { text: effective.allow?.label ?? "Yes", key: "allow" },
    ];
    if (effective.allowAlways) {
      options.push({ text: effective.allowAlways.label, key: "allowAlways" });
    }
    options.push({ text: effective.deny?.label ?? "No", key: "deny" });
    emit(this.paneId, {
      type: "permission_request",
      toolName: pendingTool?.name ?? this.agent,
      description,
      detail: effective.title || description,
      toolUseId: `${this.paneId}-${Date.now()}`,
      options,
      suggestions: null,
    });
  }

  private async emitTurnResult(): Promise<void> {
    // Order matters. The herdr idle event can beat the transcript poll, so the
    // final `say` block may still be in flight as a text_delta. Drain it FIRST,
    // then emit result, then `status idle` LAST — if idle went out before the
    // trailing text_delta, the app would treat that late text as new activity
    // and get stuck showing "inferring" with no closing idle.
    if (this.onTranscript) {
      await new Promise((r) => setTimeout(r, 1100));
    }
    // Let the paced content finish streaming before the result/idle close it
    // out — otherwise idle would land before the last chunks and the app would
    // get stuck showing activity again.
    await this.drainStream();
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
      text: renderForGlasses(text),
      sessionId: this.paneId,
      costUsd: 0,
      provider: this.provider,
      turns: 0,
      durationMs,
      inputTokens: this.turnInputTokens,
      outputTokens: this.turnOutputTokens,
    });
    emit(this.paneId, { type: "status", state: "idle", sessionId: this.paneId });
  }

  // ── inbound from the app ─────────────────────────────

  async prompt(text: string): Promise<void> {
    emit(this.paneId, { type: "user_prompt", text });
    this.cancelIdle(); // a new prompt overrides any pending idle from before
    this.screen?.resetTurn(); // new turn — allow repeats of past content
    this.clearStream(); // drop any stale content from a prior turn
    // remember our injected prompt so both the timeline's record of it (core)
    // and its wrapped screen echo (ScreenTimeline) are suppressed as duplicates.
    this.recentTyped = text.replace(/\s+/g, "");
    this.recentTypedAt = Date.now();
    this.screen?.noteTyped(text);
    await typeAndSubmit(this.paneId, text);
    if (this.state !== "busy") {
      // Optimistic busy for immediate feedback — herdr's status event would
      // otherwise see prev==busy and skip the turn-start work, so do it here.
      this.turnStartMs = Date.now();
      this.state = "busy";
      this.turnInputTokens = 0;
      this.turnOutputTokens = 0;
      this.lastProseBlock = "";
      emit(this.paneId, { type: "status", state: "busy", sessionId: this.paneId });
      this.startStats();
    }
  }

  /** Wait until the pane leaves "awaiting" (menu resolved). State is updated
   *  by herdr status events, so no extra reads are needed. */
  private async waitUnblocked(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.state !== "awaiting") return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return this.state !== "awaiting";
  }

  /** Press keys for a decision, verify the menu actually resolved, and walk a
   *  fallback ladder when it did not. Never guess silently: if nothing works,
   *  tell the app to use the terminal.
   *
   *  `steps` is a sequence of key presses delivered as SEPARATE send_input
   *  calls with a gap between them: bundling e.g. ["Down","Enter"] into one
   *  call races the TUI (Enter processed before the highlight moves), which
   *  silently picks the wrong option. */
  private async pressAndVerify(
    attempts: { label: string; steps: { text?: string; keys?: string[] }[] }[],
  ): Promise<{ ok: boolean; used: string }> {
    for (const a of attempts) {
      try {
        for (let i = 0; i < a.steps.length; i++) {
          const step = a.steps[i];
          await sendInput(this.paneId, step.text ?? "", step.keys);
          if (i < a.steps.length - 1) await new Promise((r) => setTimeout(r, 250));
        }
      } catch {
        continue;
      }
      const ok = await this.waitUnblocked(4000);
      logEvent("diag", this.paneId, { permissionAttempt: a.label, cleared: ok });
      if (ok) return { ok: true, used: a.label };
    }
    return { ok: false, used: "" };
  }

  async respondPermission(decision: string): Promise<void> {
    const menu = this.currentMenu;
    this.currentMenu = null;
    const attempts: { label: string; steps: { text?: string; keys?: string[] }[] }[] = [];
    let summary = "";
    // Key behaviour (measured on claude 2.x menus): number keys do NOT select;
    // Enter confirms the HIGHLIGHTED option (default = option 1 = Yes), arrow
    // keys move the highlight, Escape cancels. Multi-key sequences (Down then
    // Enter) MUST be separate presses — bundling races the highlight update.
    if (decision === "allowAlways") {
      const opt = menu?.allowAlways;
      summary = opt?.label ?? "Yes (always)";
      // move highlight to option 2 ("allow all this session"), then confirm
      attempts.push({ label: "down+enter", steps: [{ keys: ["Down"] }, { keys: ["Enter"] }] });
      if (opt?.digit) attempts.push({ label: `digit:${opt.digit}`, steps: [{ text: opt.digit }] });
      // degrade to allow-once rather than leaving the menu stuck
      attempts.push({ label: "enter(allow-once)", steps: [{ keys: ["Enter"] }] });
    } else if (decision === "allow") {
      summary = menu?.allow?.label ?? "Yes";
      attempts.push({ label: "enter", steps: [{ keys: ["Enter"] }] });
      if (menu?.allow?.digit) attempts.push({ label: `digit:${menu.allow.digit}`, steps: [{ text: menu.allow.digit }] });
    } else {
      summary = menu?.deny?.label ?? "No";
      attempts.push({ label: "escape", steps: [{ keys: ["Escape"] }] });
      if (menu?.deny?.digit) attempts.push({ label: `digit:${menu.deny.digit}`, steps: [{ text: menu.deny.digit }] });
    }
    const r = await this.pressAndVerify(attempts);
    if (!r.ok) {
      emit(this.paneId, {
        type: "notification",
        title: "Confirmation failed",
        message: "Could not dismiss the confirmation menu — please respond in the terminal",
      });
      return;
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
    const idx = menu?.options.findIndex(
      (o) =>
        o.label.toLowerCase() === norm ||
        o.label.toLowerCase().startsWith(norm) ||
        norm.startsWith(o.label.toLowerCase()),
    );
    if (menu && idx !== undefined && idx >= 0) {
      // Navigate by arrows: the menu opens with option 0 highlighted; press
      // Down idx times, then Enter (separate presses to avoid the race).
      const steps: { text?: string; keys?: string[] }[] = [];
      for (let i = 0; i < idx; i++) steps.push({ keys: ["Down"] });
      steps.push({ keys: ["Enter"] });
      const r = await this.pressAndVerify([{ label: `arrows×${idx}+enter`, steps }]);
      if (!r.ok) {
        emit(this.paneId, {
          type: "notification",
          title: "Selection failed",
          message: "Could not submit the choice — please respond in the terminal",
        });
        return;
      }
      emit(this.paneId, { type: "question_answer", answers: { answer: label } });
    } else {
      // No matching option. Free text into an arrow-select form is unreliable
      // (typing acts as navigation and can silently confirm the wrong option),
      // so refuse to guess — tell the user to answer in the terminal. The menu
      // stays open (nothing pressed), so nothing is lost.
      logEvent("diag", this.paneId, { questionNoMatch: label.slice(0, 60) });
      emit(this.paneId, {
        type: "notification",
        title: "No matching option",
        message: `"${label.slice(0, 30)}" is not one of the options — please answer in the terminal`,
      });
    }
  }

  async interrupt(): Promise<void> {
    await sendInput(this.paneId, "", ["Escape"]);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.clearProbe();
    this.stopStats();
    this.cancelIdle();
    this.clearStream();
    this.timeline?.dispose();
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
      // pick up the transcript as soon as the id appears
      if (info.agent_session?.value) existing.noteSessionId(info.agent_session.value);
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
