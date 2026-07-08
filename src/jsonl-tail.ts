import { createReadStream, statSync } from "node:fs";
import type { AgentEvent } from "./spine.js";

export type JsonlParser = (line: string) => AgentEvent[];

/** Wrap a parser to drop entries older than `since` (epoch ms) by reading the
 *  line's top-level ISO `timestamp`. Used when replaying a from-start transcript
 *  so a resumed / pre-existing history isn't emitted — only content since attach.
 *  Lines without a timestamp (meta records) fall through to the parser. */
export function sinceFilter(parse: JsonlParser, since?: number): JsonlParser {
  if (since === undefined) return parse;
  return (line: string): AgentEvent[] => {
    try {
      const ts = (JSON.parse(line) as { timestamp?: string }).timestamp;
      if (ts && Date.parse(ts) < since) return [];
    } catch {
      // not JSON / unexpected — let the real parser handle it
    }
    return parse(line);
  };
}

// Cap for a `fromStart` replay: read at most the last MB, so discovering a large
// existing/resumed transcript late doesn't read+parse the whole history to catch
// up (the recent, since-attach content lives at the tail). A partial first line
// from mid-file simply fails to parse and is skipped.
export const MAX_REPLAY_BYTES = 1024 * 1024;

/**
 * Incremental JSONL tailer: remembers the byte offset and returns only events
 * appended since the last call. Starts at the current end of file so attaching
 * to a live session never replays its history — pass `fromStart` to instead read
 * from near the start (capped to the last `maxReplayBytes`), for a session that
 * appeared while we were already watching, so the first turn isn't lost.
 */
export class JsonlTail {
  private offset: number;
  private partial = "";

  constructor(
    readonly filePath: string,
    private readonly parseLine: JsonlParser,
    fromStart = false,
    maxReplayBytes = MAX_REPLAY_BYTES,
  ) {
    const size = statSync(filePath).size;
    this.offset = fromStart ? Math.max(0, size - maxReplayBytes) : size;
  }

  async readNew(): Promise<AgentEvent[]> {
    const size = statSync(this.filePath).size;
    if (size < this.offset) {
      // truncated/rotated — restart from the end
      this.offset = size;
      this.partial = "";
      return [];
    }
    if (size === this.offset) return [];
    const chunk = await new Promise<string>((resolve, reject) => {
      let data = "";
      createReadStream(this.filePath, { start: this.offset, end: size - 1, encoding: "utf8" })
        .on("data", (d) => (data += d))
        .on("end", () => resolve(data))
        .on("error", reject);
    });
    this.offset = size;
    const text = this.partial + chunk;
    const lines = text.split("\n");
    this.partial = lines.pop() ?? ""; // last element may be an incomplete line
    const out: AgentEvent[] = [];
    for (const line of lines) {
      if (line.trim()) out.push(...this.parseLine(line));
    }
    return out;
  }
}
