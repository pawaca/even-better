import { createReadStream, statSync } from "node:fs";
import type { AgentEvent } from "./spine.js";

export type JsonlParser = (line: string) => AgentEvent[];

/**
 * Incremental JSONL tailer: remembers the byte offset and returns only events
 * appended since the last call. Starts at the current end of file so attaching
 * to a live session never replays its history — pass `fromStart` to instead read
 * from byte 0, for a session that was created while we were already watching (its
 * whole file is the current session, so replaying it captures the first turn).
 */
export class JsonlTail {
  private offset: number;
  private partial = "";

  constructor(
    readonly filePath: string,
    private readonly parseLine: JsonlParser,
    fromStart = false,
  ) {
    this.offset = fromStart ? 0 : statSync(filePath).size;
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
