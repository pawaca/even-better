import type { AgentEvent, Timeline } from "./spine.js";
import { diffNewLines, filterVolatile, normalizeLine, stripDurationTail } from "./parse.js";

// Scrape a redrawing TUI into coarse `say` events. This is the FALLBACK
// Timeline, used only when an agent has no structured log. Every fragile
// heuristic — snapshot diffing, volatile-line filtering, cross-render dedup,
// prompt-echo suppression — lives here and nowhere else, so a structured
// Timeline (TranscriptTimeline) never pays for any of it.

// A line emitted within this window is not emitted again. Catches TUI lines
// that flap present/absent across polls (e.g. "Running 1 shell command…") and
// re-render in bullet/bare variants. Cleared each turn via resetTurn(), so the
// window is effectively "once per turn."
const DEDUPE_WINDOW_MS = 600_000;

export interface ScreenTimelineOpts {
  read: () => Promise<string>; // reads the pane's visible screen
  windowLines: number;
  /** Optional tracing hook (label, line) for the two events the core logs. */
  trace?: (kind: "capture" | "send" | "drop", line: string) => void;
}

export class ScreenTimeline implements Timeline {
  private lastLines: string[] = [];
  private primed = false;
  private lastEmitted = "";
  private recentlyEmitted = new Map<string, number>();
  private recentTyped = "";
  private recentTypedAt = 0;

  constructor(private opts: ScreenTimelineOpts) {}

  /** Record text we injected ourselves, so its wrapped screen echo is dropped
   *  (the app already shows the prompt via its own user_prompt event). */
  noteTyped(text: string): void {
    this.recentTyped = text.replace(/\s+/g, "");
    this.recentTypedAt = Date.now();
  }

  /** New turn: allow content identical to a previous turn to reappear. */
  resetTurn(): void {
    this.recentlyEmitted.clear();
  }

  async poll(): Promise<AgentEvent[]> {
    let raw: string;
    try {
      raw = await this.opts.read();
    } catch {
      return [];
    }
    const lines = filterVolatile(raw.split("\n")).map(normalizeLine);
    if (!this.primed) {
      // First poll seeds the baseline WITHOUT emitting, so content already on
      // screen when the bridge attached is not replayed to the app.
      this.lastLines = lines;
      this.primed = true;
      return [];
    }
    const added = diffNewLines(this.lastLines, lines);
    this.lastLines = lines;
    if (added.length === 0) return [];
    this.opts.trace?.("capture", `+${added.length} line(s)`);

    const kept: string[] = [];
    for (const line of added) {
      const t = line.trim();
      if (!t) continue;
      if (this.isTypedEcho(line)) {
        this.opts.trace?.("drop", `echo: ${t.slice(0, 90)}`);
        continue;
      }
      // Dedupe key ignores the leading "⏺" bullet (same status line renders
      // both standalone and bullet-prefixed) and any elapsed-time suffix
      // (in-progress commands re-render "… (4s)" → "… (5s)" every second).
      const key = stripDurationTail(t.replace(/^⏺\s*/, ""));
      const at = this.recentlyEmitted.get(key);
      if (at !== undefined && Date.now() - at < DEDUPE_WINDOW_MS) {
        this.opts.trace?.("drop", `dupe: ${t.slice(0, 90)}`);
        continue;
      }
      this.recentlyEmitted.set(key, Date.now());
      kept.push(line);
    }
    if (this.recentlyEmitted.size > 500) {
      const cutoff = Date.now() - DEDUPE_WINDOW_MS;
      for (const [k, ts] of this.recentlyEmitted) if (ts < cutoff) this.recentlyEmitted.delete(k);
    }
    if (kept.length === 0) return [];
    const text = kept.join("\n");
    if (text === this.lastEmitted) return []; // safety net against re-emits
    this.lastEmitted = text;
    this.opts.trace?.("send", `${kept.length} line(s)`);
    return [{ t: "say", text }];
  }

  private isTypedEcho(line: string): boolean {
    if (!this.recentTyped || Date.now() - this.recentTypedAt > 120_000) return false;
    const norm = line.replace(/\s+/g, "");
    return norm.length >= 4 && this.recentTyped.includes(norm);
  }

  dispose(): void {
    this.recentlyEmitted.clear();
  }
}
