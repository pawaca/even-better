// Device-facing render transforms: pure `string -> string` functions that
// adapt assistant text to the glasses' narrow 576×288 panel. Composed into
// `renderForGlasses` and applied to `say` text just before it goes on the
// wire. Kept as plain functions (not a polymorphic Renderer interface) until a
// second output device actually exists — see docs/ARCHITECTURE.md.

/**
 * Reflow markdown tables into a vertical list. A grid like
 *
 *   | Name  | Age | City |
 *   |-------|-----|------|
 *   | Alice | 30  | NYC  |
 *
 * wraps into unreadable soup on a narrow panel. Reflow uses the first column as
 * an item heading and the rest as `key: value` lines beneath it:
 *
 *   • Alice
 *     Age: 30
 *     City: NYC
 *
 * Non-table text passes through untouched.
 */
export function reflowTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const block = tableAt(lines, i);
    if (block) {
      out.push(...renderTable(block.header, block.rows));
      i = block.end;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
}

interface TableBlock {
  header: string[];
  rows: string[][];
  end: number; // index after the table
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

const isSeparator = (line: string): boolean =>
  /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);

const looksLikeRow = (line: string): boolean => {
  const t = line.trim();
  return t.includes("|") && (t.startsWith("|") || (t.match(/\|/g)?.length ?? 0) >= 2);
};

/** Detect a markdown table starting at `start` (header row + separator + ≥1
 *  data row). Returns null if there is none. */
function tableAt(lines: string[], start: number): TableBlock | null {
  const header = lines[start];
  const sep = lines[start + 1];
  if (!header || !sep || !looksLikeRow(header) || !isSeparator(sep)) return null;
  const cols = splitRow(header);
  if (cols.length < 2) return null;
  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length && looksLikeRow(lines[i]) && !isSeparator(lines[i])) {
    rows.push(splitRow(lines[i]));
    i++;
  }
  if (rows.length === 0) return null;
  return { header: cols, rows, end: i };
}

function renderTable(header: string[], rows: string[][]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const head = row[0] ?? "";
    out.push(`• ${head}`.trimEnd());
    for (let c = 1; c < header.length; c++) {
      const key = header[c] ?? "";
      const val = row[c] ?? "";
      if (!val) continue;
      out.push(key ? `  ${key}: ${val}` : `  ${val}`);
    }
  }
  return out;
}

/**
 * Strip heavy box-drawing table borders (╭─┬─╮ │ ├ etc.) that the terminal
 * renders for tool boxes. We cannot reliably re-tabulate a scraped box, but
 * dropping the border glyphs and collapsing separator-only rows leaves the cell
 * text legible instead of a wall of line-drawing characters.
 */
export function stripBoxBorders(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/[│┃]/g, " ").replace(/\s{2,}/g, "  ").trimEnd())
    .filter((l) => !/^[\s─━┄┈╌═┌┬┐├┼┤└┴┘╭┬╮╰┴╯╞╪╡]+$/.test(l))
    .join("\n");
}

/** The glasses render pipeline. Order matters: reflow markdown tables first
 *  (while their `|` structure is intact), then strip any residual box borders. */
export function renderForGlasses(text: string): string {
  return stripBoxBorders(reflowTables(text));
}
