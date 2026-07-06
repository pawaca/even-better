// Paced output queue. Text items type out a few code points per tick so a long
// answer reveals smoothly instead of in one burst; event items (e.g.
// tool_start) are released whole, in order with the surrounding text. The
// per-tick character count scales with the backlog so long answers stay
// bounded in time. Pulled out of the bridge so it is small and unit-testable.

// A text item streams `chars` from `pos`; an event item is emitted whole.
type Item = { chars: string[]; pos: number } | { event: object };

export class OutputStream {
  private queue: Item[] = [];
  private pacer: ReturnType<typeof setTimeout> | null = null;

  /** @param emit sink for one wire message. @param tickMs gap between frames. */
  constructor(
    private readonly emit: (msg: object) => void,
    private readonly tickMs = 100,
  ) {}

  /** Queue text to type out gradually. Split by code point so a surrogate pair
   *  (emoji) is never cut across two frames. */
  text(text: string): void {
    if (!text) return;
    this.queue.push({ chars: [...text], pos: 0 });
    if (!this.pacer) this.tick();
  }

  /** Queue a whole event (e.g. tool_start) to release in order with the text. */
  event(msg: object): void {
    this.queue.push({ event: msg });
    if (!this.pacer) this.tick();
  }

  /** Resolve once the queue has fully drained. */
  async drain(): Promise<void> {
    while (this.queue.length > 0 || this.pacer) {
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  clear(): void {
    this.queue = [];
    if (this.pacer) {
      clearTimeout(this.pacer);
      this.pacer = null;
    }
  }

  /** Immediately emit everything still queued, preserving item order. Used at
   *  turn close-out so result/idle do not wait behind paced typing. */
  flush(): void {
    if (this.pacer) {
      clearTimeout(this.pacer);
      this.pacer = null;
    }
    const items = this.queue;
    this.queue = [];
    for (const item of items) {
      if ("event" in item) {
        this.emit(item.event);
        continue;
      }
      const rest = item.chars.slice(item.pos).join("");
      if (rest) this.emit({ type: "text_delta", text: rest });
    }
  }

  private pendingChars(): number {
    let n = 0;
    for (const it of this.queue) if ("chars" in it) n += it.chars.length - it.pos;
    return n;
  }

  private tick(): void {
    const head = this.queue[0];
    if (!head) {
      this.pacer = null;
      return;
    }
    if ("event" in head) {
      this.emit(head.event);
      this.queue.shift();
    } else {
      // Chars per tick scale with the backlog so a long answer stays bounded
      // (~10s) while a short one types gently; never fewer than 4.
      const n = Math.min(30, Math.max(4, Math.ceil(this.pendingChars() / 120)));
      this.emit({ type: "text_delta", text: head.chars.slice(head.pos, head.pos + n).join("") });
      head.pos += n;
      if (head.pos >= head.chars.length) this.queue.shift();
    }
    this.pacer = setTimeout(() => this.tick(), this.tickMs);
  }
}
