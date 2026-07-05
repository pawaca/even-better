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
import {
  classifyMenu,
  diffNewLines,
  extractResult,
  filterVolatile,
  parseMenu,
  type ClassifiedMenu,
  type ParsedMenu,
} from "./parse.js";

const OUTPUT_WINDOW_LINES = 120;
const FLUSH_INTERVAL_MS = 400;
// pane.output_matched is edge-triggered (fires only when the first regex-
// matching line changes), so it cannot serve as an output firehose. We poll
// the pane instead; a unix-socket read of ≤120 lines every 600ms is cheap.
const POLL_INTERVAL_MS = 600;

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
  state: AppState = "idle";

  private sub: SubscribeHandle | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private lastLines: string[] = [];
  private pendingOut: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private turnStartMs = 0;
  private currentMenu: (ParsedMenu & ClassifiedMenu) | null = null;
  private disposed = false;

  constructor(info: AgentInfo) {
    this.paneId = info.pane_id;
    this.agent = info.agent;
    this.cwd = info.cwd;
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
      const text = await paneRead(this.paneId, "visible", OUTPUT_WINDOW_LINES);
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
  }

  private startPolling(): void {
    if (this.pollTimer || this.disposed) return;
    if (process.env.DEBUG_POLL === "1") {
      console.log(`[poll ${this.paneId}] polling started`);
    }
    this.pollTimer = setInterval(() => {
      if (this.polling) return;
      this.polling = true;
      paneRead(this.paneId, "visible", OUTPUT_WINDOW_LINES)
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
    const lines = filterVolatile(text.split("\n"));
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
    if (process.env.DEBUG_POLL === "1" && added.length > 0) {
      console.log(`[poll ${this.paneId}] +${added.length} lines`);
    }
    if (added.length === 0) return;
    this.pendingOut.push(...added);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushOutput(), FLUSH_INTERVAL_MS);
    }
  }

  private flushOutput(): void {
    this.flushTimer = null;
    if (this.pendingOut.length === 0) return;
    const text = this.pendingOut.join("\n").trimEnd();
    this.pendingOut = [];
    if (!text.trim()) return;
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
    try {
      let raw = await paneRead(this.paneId, "recent_unwrapped", OUTPUT_WINDOW_LINES);
      if (!raw.trim()) {
        // recent scrollback is empty until content scrolls off-screen
        raw = await paneRead(this.paneId, "visible", OUTPUT_WINDOW_LINES);
      }
      text = extractResult(raw.split("\n"));
    } catch {
      // pane may be gone; result stays empty
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
