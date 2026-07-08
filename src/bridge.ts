import {
  getMux,
  typeAndSubmit,
  type Explanation,
  type PaneInfo,
  type PaneStatus,
  type StatusSub,
} from "./multiplexer.js";
import { emit } from "./sse.js";
import { logEvent, tracesStream } from "./log.js";
import type { AgentEvent, Timeline } from "./spine.js";
import { CodexTranscriptTimeline, findCodexSessionFile } from "./codex-transcript.js";
import { findSessionFile, summarizeTool, TranscriptTimeline } from "./transcript.js";
import { ScreenTimeline } from "./screen-timeline.js";
import { OutputStream } from "./output-stream.js";
import { renderForGlasses } from "./render.js";
import {
  classifyMenu,
  extractResult,
  parseMenu,
  type ClassifiedMenu,
  type ParsedMenu,
} from "./parse.js";

// Human-readable stream tracing on the server console (LOG=trace): dim = new
// screen content captured by the diff, green = what is actually sent to the
// glasses app, yellow = lines suppressed and why.
const STREAM_LOG = tracesStream;
const USE_COLOR = process.stdout.isTTY === true;
function paint(code: string, s: string): string {
  return USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s;
}

const OUTPUT_WINDOW_LINES = 120;
// Cadence at which the active Timeline is polled. The transcript tail (cheap
// stat) and the screen scrape (a socket read of ≤120 lines) both tolerate this.
const POLL_INTERVAL_MS = 300;
// While on the screen fallback, re-fetch the pane's session id and retry the
// transcript lookup at most this often (piggybacked on the timeline poll) — the
// bounded successor to the removed dedicated 2s session probe.
const TRANSCRIPT_RETRY_MS = 1000;
// How long herdr must stay "idle" before we treat a turn as ended. herdr flips
// to idle transiently between tool calls (prompt box flashes), so committing
// immediately blanks the thinking indicator and fires a spurious result. A busy
// signal within this window cancels the pending idle (the agent resumed); if
// idle persists, the turn is really over.
const IDLE_GRACE_MS = 3500;
// Text-reveal cadence on the glasses: ms between text_delta frames. Larger =
// slower, more readable. Default 140 (~20 chars/s for a short answer); override
// with STREAM_TICK_MS if that still scrolls off too fast.
const STREAM_TICK_MS = (() => {
  const raw = Number(process.env.STREAM_TICK_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 140;
})();

interface TodoItem {
  status?: string;
  content?: string;
  activeForm?: string;
}

interface PlanItem {
  status?: string;
  step?: string;
}

export interface StructuredQuestion {
  question: string;
  header: string;
  options: { label: string; description: string }[];
}

/** Build an AskUserQuestion form from a pending tool's jsonl input — claude
 *  carries the exact question text and per-option descriptions there, richer and
 *  more reliable than scraping the rendered menu (which also mis-guesses the
 *  title). Returns null unless it's a single-question AskUserQuestion with ≥1
 *  labelled option, so the arrow-nav response still maps 1:1 to the on-screen
 *  order. */
export function structuredQuestion(
  pending: { name: string; input: Record<string, unknown> } | undefined,
): StructuredQuestion | null {
  if (!pending || pending.name !== "AskUserQuestion") return null;
  const questions = pending.input.questions;
  if (!Array.isArray(questions) || questions.length !== 1) return null;
  const q = questions[0];
  if (typeof q !== "object" || q === null) return null;
  const rec = q as Record<string, unknown>;
  if (!Array.isArray(rec.options)) return null;
  const options = rec.options
    .map((o) => {
      const or = (typeof o === "object" && o !== null ? o : {}) as Record<string, unknown>;
      return {
        label: typeof or.label === "string" ? or.label : "",
        description: typeof or.description === "string" ? or.description : "",
      };
    })
    .filter((o) => o.label);
  if (options.length === 0) return null;
  return {
    question: typeof rec.question === "string" ? rec.question : "Choose an option",
    header: typeof rec.header === "string" ? rec.header : "",
    options,
  };
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

/** Map Codex update_plan input to the app's task_progress widget fields. */
export function planProgress(
  input: Record<string, unknown>,
): { completed: number; total: number; current: string } | null {
  const plan = Array.isArray(input.plan) ? (input.plan as PlanItem[]) : [];
  const total = plan.length;
  if (!total) return null;
  const completed = plan.filter((p) => p?.status === "completed").length;
  const active = plan.find((p) => p?.status === "in_progress");
  const current = active?.step ?? (completed === total ? "All done" : "");
  return { completed, total, current };
}

function isPlanTool(name: string): boolean {
  return name === "update_plan" || name === "functions.update_plan";
}

type PendingTool = { name: string; input: Record<string, unknown> };

export function permissionPresentation(
  menu: ParsedMenu | null,
  classified: ClassifiedMenu | null,
  pendingTool: PendingTool | undefined,
): "emit" | "notify" {
  if (menu && classified?.kind === "permission") return "emit";
  if (pendingTool) return "emit";
  return "notify";
}

export function shouldIgnoreNonVisibleBlocker(menu: ParsedMenu | null, explain: Explanation): boolean {
  return menu === null && explain.visibleBlocker === false;
}

export function ignoredBlockerAction(
  turnStarted: boolean,
  canceledIdleClose: boolean,
): "busy" | "idle" | "rearmIdle" {
  if (!turnStarted) return "idle";
  return canceledIdleClose ? "rearmIdle" : "busy";
}

export type AppState = "idle" | "busy" | "awaiting";

/** Normalized status → the bridge's turn-state view. `closed` is handled as a
 *  disposal signal by onStatus, never stored as an AppState. */
function toAppState(s: PaneStatus): AppState {
  return s === "busy" ? "busy" : s === "awaiting" ? "awaiting" : "idle";
}

/**
 * PaneBridge mirrors one agent pane (from any Multiplexer) as an even-terminal
 * "session": watches normalized status, diffs new output into text_delta
 * messages, turns blocked screens into permission_request/user_question, and
 * injects prompts/decisions back through the Multiplexer.
 */
export class PaneBridge {
  readonly paneId: string;
  agent: string;
  cwd: string;
  agentSessionId: string | undefined;
  state: AppState = "idle";

  private sub: StatusSub | null = null;
  // The active event source. `timeline` is what the poll loop drives; `screen`
  // aliases it only when it is a ScreenTimeline (for noteTyped/resetTurn).
  private timeline: Timeline | null = null;
  private screen: ScreenTimeline | null = null;
  private onTranscript = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  // Throttle for the screen-fallback session re-fetch (see TRANSCRIPT_RETRY_MS).
  private lastUpgradeTryMs = 0;
  private statsTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private idleCanceledForAwaiting = false;

  private recentTyped = ""; // our injected prompt, to suppress its echo in the timeline
  private recentTypedAt = 0;
  private turnStartMs = 0;
  private currentMenu: (ParsedMenu & ClassifiedMenu) | null = null;
  private disposed = false;

  private lastProseBlock = "";
  private turnSuccess = true;
  private turnResultText = "";
  private pendingTools = new Map<string, PendingTool>();
  private turnInputTokens = 0;
  private turnOutputTokens = 0;

  // Paced output: text types out gradually, tool_start events interleave in
  // order. Widgets bypass it; result/idle wait for it to drain.
  private readonly out = new OutputStream((msg) => emit(this.paneId, msg), STREAM_TICK_MS);

  constructor(info: PaneInfo) {
    this.paneId = info.paneId;
    this.agent = info.agent;
    this.cwd = info.cwd;
    this.agentSessionId = info.sessionId;
    this.state = toAppState(info.status);
  }

  get provider(): string {
    return this.agent === "codex" ? "codex" : "claude";
  }

  start(): void {
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.disposed) return;
    this.sub = getMux().watchStatus(
      this.paneId,
      (s, session) => this.onStatus(s, session),
      (err) => this.onSubClosed(err),
    );
    // A pane can already be blocked when the bridge discovers it (e.g. trust
    // dialog on startup) — no transition event will fire, so emit the menu now.
    if (this.state === "awaiting") void this.emitBlockedMenu();
    this.selectTimeline();
    this.startPolling();
  }

  /** Pick the content source: the agent transcript when available (structured,
   *  lossless), else a ScreenTimeline fallback that scrapes the TUI. */
  private selectTimeline(): void {
    if (this.agentSessionId && this.upgradeToTranscript(this.agentSessionId)) return;
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

  private upgradeToTranscript(id: string): boolean {
    if (this.agent === "claude") {
      const file = findSessionFile(id);
      if (!file) return false;
      this.agentSessionId = id;
      this.screen?.dispose();
      this.timeline = new TranscriptTimeline(file);
      this.screen = null;
      this.onTranscript = true;
      console.log(`[bridge ${this.paneId}] tailing transcript ${file}`);
      return true;
    }
    if (this.agent === "codex") {
      const file = findCodexSessionFile(id);
      if (!file) return false;
      this.agentSessionId = id;
      this.screen?.dispose();
      this.timeline = new CodexTranscriptTimeline(file);
      this.screen = null;
      this.onTranscript = true;
      console.log(`[bridge ${this.paneId}] tailing codex transcript ${file}`);
      return true;
    }
    return false;
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

  /** A session id became known — from agent.list (manager) or a status event
   *  that carried it (multiplexer). Upgrade to the transcript if we are still on
   *  the screen fallback; a no-op once tailing. */
  noteSessionId(id: string): void {
    if (this.onTranscript || this.disposed) return;
    this.upgradeToTranscript(id);
  }

  private startPolling(): void {
    if (this.pollTimer || this.disposed) return;
    this.pollTimer = setInterval(() => {
      // Resolve the transcript off the screen fallback, throttled, on this
      // existing timer (no dedicated probe). Re-fetch the pane's CURRENT session
      // each time and try the upgrade — one path that covers a lagging jsonl, a
      // session that later changes, and older herdr that never pushed
      // agent_session on the status event (so we don't wait on an app /sessions
      // poll). A status event that carries the session upgrades sooner via
      // noteSessionId; this is the fallback. On success a later tick polls it.
      if (
        !this.polling &&
        !this.onTranscript &&
        (this.agent === "claude" || this.agent === "codex") &&
        Date.now() - this.lastUpgradeTryMs >= TRANSCRIPT_RETRY_MS
      ) {
        this.lastUpgradeTryMs = Date.now();
        void getMux()
          .sessionId(this.paneId)
          .then((id) => {
            if (id && !this.onTranscript) this.noteSessionId(id);
          })
          .catch(() => {});
      }
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
    return getMux().read(this.paneId, OUTPUT_WINDOW_LINES);
  }

  /** Map one provider-neutral AgentEvent to the app wire protocol. Provider-,
   *  source-, and heuristic-agnostic — a `say` is a `say` whether it came from
   *  the jsonl or a scraped screen. */
  private onAgentEvent(e: AgentEvent): void {
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
        // Stream the whole rendered block; OutputStream types it in smoothly
        // with no artificial line breaks. The trailing "\n" only separates this
        // block from the next.
        this.out.text(renderForGlasses(text) + "\n");
        return;
      }
      case "usage": {
        // Producers emit usage as turn-local deltas. Provider-specific
        // cumulative snapshots and duplicate samples must be normalized before
        // they reach the bridge, so the core can just sum the spine event.
        this.turnInputTokens += e.usage.input;
        this.turnOutputTokens += e.usage.output;
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
        if (isPlanTool(e.name)) {
          const progress = planProgress(e.input);
          if (progress) emit(this.paneId, { type: "task_progress", ...progress });
          return; // plan updates drive the progress widget, not a tool bubble
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
        this.out.event({
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
        const summary = summarizeTool(pending.name, pending.input);
        this.out.event({
          type: "tool_end",
          name: pending.name,
          toolId: e.id,
          // even-terminal's tool_end has no error field, so surface a failed tool
          // (claude is_error / codex non-ok output) in the rendered summary —
          // otherwise the failure flag never reaches the app.
          summary: e.ok ? summary : `[failed] ${summary}`,
          detail: { input: pending.input, output: e.output.slice(0, 1500) },
        });
        return;
      }
      case "turnEnd": {
        this.turnSuccess = e.success;
        const text = e.text?.trim();
        if (text) this.turnResultText = text;
        return;
      }
    }
  }

  private onSubClosed(_err?: Error): void {
    this.sub = null;
    if (this.disposed) return;
    // The status stream dropped (mux restarted); retry while the pane still exists.
    setTimeout(() => {
      void getMux()
        .exists(this.paneId)
        .then((exists) => {
          if (exists) this.connect();
          else this.dispose();
        });
    }, 2000);
  }

  // ── status transitions ───────────────────────────────

  private onStatus(raw: PaneStatus, session?: string): void {
    if (raw === "closed") {
      this.dispose();
      return;
    }
    // The backend hands us the session id on the same event that reveals it
    // (herdr's status event, cmux's SessionStart-refreshed maps) — upgrade to the
    // transcript here instead of polling for it.
    if (session) this.noteSessionId(session);
    const next = toAppState(raw);
    console.log(`[bridge ${this.paneId}] status ${this.state} -> ${next} (mux: ${raw})`);

    if (next === "busy") {
      // Any working signal cancels a pending idle — that idle was just a blip
      // between tool operations, not a real turn end.
      this.idleCanceledForAwaiting = false;
      this.cancelIdle();
      if (this.state !== "busy") this.enterBusyTurn();
      return;
    }

    if (next === "awaiting") {
      const canceledIdle = this.idleTimer !== null;
      this.cancelIdle();
      if (this.state !== "awaiting") {
        this.idleCanceledForAwaiting = canceledIdle;
        this.state = "awaiting";
        void this.emitBlockedMenu();
      }
      return;
    }

    // next === "idle": DEBOUNCE. herdr reports a transient idle whenever the
    // pane isn't showing the working spinner (e.g. its prompt box flashes
    // between tool calls), which would otherwise blank the thinking indicator
    // and fire a spurious result mid-turn. Only commit the turn end after idle
    // persists for IDLE_GRACE_MS; a busy signal (agent resumed) cancels it. We
    // do NOT cancel on content: the final block often lands during the grace
    // (jsonl lags herdr), and herdr sends no second idle to re-arm the timer,
    // so canceling there would strand the turn as "streaming" forever.
    this.scheduleIdleClose();
  }

  private scheduleIdleClose(): void {
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
    this.idleCanceledForAwaiting = false;
    this.screen?.resetTurn(); // new turn — allow repeats of past content
    this.out.clear(); // drop any stale content from a prior turn
    this.turnInputTokens = 0;
    this.turnOutputTokens = 0;
    this.lastProseBlock = ""; // don't let a prose-less turn reuse old text
    this.turnSuccess = true;
    this.turnResultText = "";
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

  private finishIgnoredBlocker(explain: Explanation): void {
    logEvent("diag", this.paneId, {
      blockedIgnored: {
        rule: explain.rule ?? null,
        visibleBlocker: explain.visibleBlocker ?? null,
        reason: "non-visible-blocker",
      },
    });
    this.currentMenu = null;
    const action = ignoredBlockerAction(this.turnStartMs > 0, this.idleCanceledForAwaiting);
    this.idleCanceledForAwaiting = false;
    if (action === "idle") {
      this.state = "idle";
      this.stopStats();
      emit(this.paneId, { type: "status", state: "idle", sessionId: this.paneId });
    } else {
      this.state = "busy";
      if (action === "rearmIdle") this.scheduleIdleClose();
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
    const mux = getMux();
    let screen = "";
    try {
      screen = await mux.read(this.paneId, 45);
    } catch {
      return;
    }
    // agent.explain is an optional Multiplexer capability (herdr only). Without
    // it (cmux), fall back to screen classification alone.
    let explain: Explanation = {};
    if (mux.explain) {
      try {
        explain = await mux.explain(this.paneId);
      } catch {
        // explain unavailable — fall back to screen classification alone
      }
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

    if (shouldIgnoreNonVisibleBlocker(menu, explain)) {
      this.finishIgnoredBlocker(explain);
      return;
    }

    // Menu type: trust herdr's rule id first, then the backend's own kind hint
    // (cmux knows question vs permission from the hook that opened it), then
    // screen classification. The hint keeps an AskUserQuestion from degrading
    // into a synthesized Yes/No permission when the screen parse is inconclusive.
    const rule = explain.rule ?? "";
    const kindHint = mux.interactionKind?.(this.paneId);
    const kind: "permission" | "question" =
      /form|workflow/.test(rule)
        ? "question"
        : /permission|blocker/.test(rule)
          ? "permission"
          : (kindHint ?? classified?.kind ?? "permission");

    if (kind === "question") {
      // Prefer the structured form from the transcript (exact question + per-option
      // descriptions) — but only when the screen also parses, because the response
      // verifies dismissal via `menuGone()`/`parseMenu`: if the screen were
      // unparseable we'd acknowledge a possibly-lost keypress as answered. When
      // both are present, the transcript gives richer labels and the screen keeps
      // verification honest. Option order matches, so arrow-nav by index is valid.
      const structured = menu ? structuredQuestion(pendingTool) : null;
      if (structured) {
        this.currentMenu = {
          title: structured.question,
          options: structured.options.map((o, i) => ({ digit: String(i + 1), label: o.label })),
          kind: "question",
        };
        emit(this.paneId, {
          type: "user_question",
          questions: [
            {
              question: structured.question,
              header: structured.header,
              options: structured.options.map((o) => ({
                label: o.label,
                description: o.description,
                preview: "",
              })),
            },
          ],
          toolUseId: `${this.paneId}-${Date.now()}`,
        });
        return;
      }
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

    // Permission: only emit an actionable app prompt when we can tie the blocked
    // state to a live menu or a pending tool. herdr's weak whole_recent blocker
    // can match ordinary transcript prose plus a stale prompt marker; turning
    // that into Allow/Deny would create a fake approval.
    const presentation = permissionPresentation(menu, classified, pendingTool);
    if (presentation === "notify") {
      logEvent("diag", this.paneId, {
        blockedIgnored: {
          rule: explain.rule ?? null,
          visibleBlocker: explain.visibleBlocker ?? null,
          reason: "unparseable-permission",
        },
      });
      emit(this.paneId, {
        type: "notification",
        title: "Agent waiting",
        message: "An unparseable permission prompt is open — please respond in the terminal",
      });
      return;
    }

    // Permission: options from the parsed menu, or synthesized standard ones
    // when a structured pending tool proves an approval is actually open.
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
    // Release any paced tail before result/idle close the turn. This preserves
    // wire order without making long answers delay the terminal state.
    this.out.flush();
    let text = "";
    if (this.turnResultText) {
      text = this.turnResultText;
    } else if (this.lastProseBlock) {
      // the transcript's final assistant text is the authoritative answer
      text = this.lastProseBlock;
    } else {
      try {
        const raw = await this.readPane();
        text = extractResult(raw.split("\n"));
      } catch {
        // pane may be gone; result stays empty
      }
    }
    const durationMs = this.turnStartMs ? Date.now() - this.turnStartMs : 0;
    const success = this.turnSuccess;
    this.turnStartMs = 0;
    this.turnSuccess = true;
    this.turnResultText = "";
    this.lastProseBlock = "";
    emit(this.paneId, {
      type: "result",
      success,
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
    // remember our injected prompt so both the timeline's record of it (core)
    // and its wrapped screen echo (ScreenTimeline) are suppressed as duplicates.
    this.recentTyped = text.replace(/\s+/g, "");
    this.recentTypedAt = Date.now();
    this.screen?.noteTyped(text);
    await typeAndSubmit(getMux(), this.paneId, text);
    // Optimistically enter the turn for immediate feedback — herdr's status
    // event would otherwise see state==busy and skip the turn-start work.
    if (this.state !== "busy") this.enterBusyTurn();
  }

  /** Wait until the pane leaves "awaiting" (menu resolved). State is updated
   *  by herdr status events, so no extra reads are needed. */
  private async waitUnblocked(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.state !== "awaiting") return true;
      // The status stream can stay on `awaiting` after the keys land (cmux only
      // leaves awaiting on a later hook like PreToolUse/Stop), so also confirm
      // from the screen: no parseable menu means the response was accepted. The
      // next hook drives state off awaiting through the normal onStatus path.
      if (await this.menuGone()) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return this.state !== "awaiting";
  }

  private async menuGone(): Promise<boolean> {
    try {
      return parseMenu(await getMux().read(this.paneId, 45)) === null;
    } catch {
      return false;
    }
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
          await getMux().send(this.paneId, step.text ?? "", step.keys);
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
    await getMux().send(this.paneId, "", ["Escape"]);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.stopStats();
    this.cancelIdle();
    this.out.clear();
    this.timeline?.dispose();
    this.sub?.close();
    console.log(`[bridge ${this.paneId}] disposed`);
  }
}

// ── manager ────────────────────────────────────────────

const bridges = new Map<string, PaneBridge>();

/** Reconcile bridges with the multiplexer's current pane list; returns the list. */
export async function refreshAgents(): Promise<PaneInfo[]> {
  const agents = await getMux().listPanes();
  const seen = new Set<string>();
  for (const info of agents) {
    seen.add(info.paneId);
    const existing = bridges.get(info.paneId);
    if (existing) {
      existing.agent = info.agent;
      existing.cwd = info.cwd;
      // the agent session may only become known after the first prompt —
      // pick up the transcript as soon as the id appears
      if (info.sessionId) existing.noteSessionId(info.sessionId);
    } else {
      const b = new PaneBridge(info);
      bridges.set(info.paneId, b);
      b.start();
      console.log(`[bridge] tracking ${info.agent} pane ${info.paneId} (${info.cwd})`);
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

export function focusedOrFirstBridge(agents: PaneInfo[]): PaneBridge | undefined {
  const focused = agents.find((a) => a.focused);
  const target = focused ?? agents[0];
  return target ? bridges.get(target.paneId) : undefined;
}

export function disposeAll(): void {
  for (const b of bridges.values()) b.dispose();
  bridges.clear();
}
