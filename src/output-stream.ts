// Paced output queue. Text items type out a few code points per tick so a long
// answer reveals smoothly instead of in one burst; event items (e.g.
// tool_start) are released whole, in order with the surrounding text. The
// per-tick character count scales with the backlog so long answers stay
// bounded in time. Pulled out of the bridge so it is small and unit-testable.

// A text item streams `chars` from `pos`; an event item is emitted whole.
type Item = { chars: string[]; pos: number } | { event: object };

const isSpace = (c: string): boolean => /\s/.test(c);

// How far past `pos+step` we'll reach to finish a space-delimited word. Longer than any
// normal word, so Latin words are kept whole; a spaceless run (CJK prose, minified JSON, a
// bare URL) has no space within reach, so it keeps normal step pacing instead of bursting.
const MAX_WORD_EXTEND = 24;

/** End a frame at a WORD boundary when one is within reach. Take ~`step` code points; if
 *  that lands inside a space-delimited word AND a space is at most `MAX_WORD_EXTEND` further
 *  on, extend past the rest of the word and its trailing whitespace so the word is never
 *  split across frames (the glasses wrap at spaces, so a split word could land on two lines).
 *  If no space is within reach — a long spaceless run — DON'T extend: return the raw `step`
 *  boundary so such text (notably CJK) still paces smoothly rather than arriving in one
 *  burst. Pure + unit-tested. */
export function frameEnd(chars: string[], pos: number, step: number): number {
  const raw = Math.min(pos + step, chars.length);
  if (raw >= chars.length) return raw; // last frame — nothing after it to split
  const limit = Math.min(raw + MAX_WORD_EXTEND, chars.length);
  let end = raw;
  while (end < limit && !isSpace(chars[end])) end++; // reach for the end of the current word
  if (end >= limit) return raw; // no space within reach → spaceless run, keep step pacing
  while (end < chars.length && isSpace(chars[end])) end++; // include its trailing space run
  return end;
}

export class OutputStream {
  private queue: Item[] = [];
  private pacer: ReturnType<typeof setTimeout> | null = null;

  /** @param emit sink for one wire message. @param tickMs gap between frames
   *  (larger = slower reveal; the bridge sets this from `STREAM_TICK_MS`). */
  constructor(
    private readonly emit: (msg: object) => void,
    private readonly tickMs = 140,
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
      // while a short one types gently enough to read on the glasses; never
      // fewer than 3. At the default tickMs a short answer reveals ~20 chars/s.
      const n = Math.min(18, Math.max(3, Math.ceil(this.pendingChars() / 160)));
      const end = frameEnd(head.chars, head.pos, n);
      this.emit({ type: "text_delta", text: head.chars.slice(head.pos, end).join("") });
      head.pos = end;
      if (head.pos >= head.chars.length) this.queue.shift();
    }
    this.pacer = setTimeout(() => this.tick(), this.tickMs);
  }
}
