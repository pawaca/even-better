// The spine: a provider-neutral vocabulary that everything speaks. Upstream
// (transcript tail, screen scrape, future agents) produces AgentEvents;
// downstream (wire emission, rendering) consumes them. Nothing outside the
// producers needs to know whether an event came from jsonl or a scraped TUI.

export interface Usage {
  input: number;
  output: number;
}

// `usage` is a property of an assistant message, which can expand to several
// events; producers attach it to at most ONE event per message so a consumer
// can sum it without double-counting.
export type AgentEvent =
  | { t: "prompt"; text: string } // a user turn (typed in the terminal or injected)
  | { t: "say"; text: string; usage?: Usage } // assistant prose
  | { t: "tool"; id: string; name: string; input: Record<string, unknown>; usage?: Usage }
  | { t: "toolResult"; id: string; output: string; ok: boolean }
  | { t: "turnEnd"; success: boolean; text?: string } // explicit turn outcome from a structured transcript
  | { t: "usage"; usage: Usage }; // token accounting emitted separately by some agents

/**
 * A source of AgentEvents for one agent in one pane. Passive: the core polls
 * it. Two implementations exist — TranscriptTimeline (Claude jsonl, structured
 * and lossless) and ScreenTimeline (any agent via screen scraping, lossy
 * fallback that owns every dedup/filter heuristic). Over a structured Timeline
 * those heuristics simply never run.
 */
export interface Timeline {
  /** Return only events appended since the last call (empty when nothing new). */
  poll(): Promise<AgentEvent[]>;
  dispose(): void;
}
