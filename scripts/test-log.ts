import { sanitizeForLog } from "../src/log.js";

const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "✅" : "❌"} ${name}: ${JSON.stringify(got)?.slice(0, 120)}`);
};

t(
  "redacts-token-query",
  sanitizeForLog({ query: { token: "secret", defaultProvider: "codex" } }),
  { query: { token: "[REDACTED]", defaultProvider: "codex" } },
);

t(
  "keeps-token-counts",
  sanitizeForLog({ inputTokens: 12, outputTokens: 3 }),
  { inputTokens: 12, outputTokens: 3 },
);

t(
  "redacts-url-and-bearer",
  sanitizeForLog({ url: "https://x.test?token=abc123&defaultProvider=codex", authorization: "Bearer abc123" }),
  { url: "https://x.test?token=[REDACTED]&defaultProvider=codex", authorization: "[REDACTED]" },
);
