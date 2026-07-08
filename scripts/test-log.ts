import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeForLog } from "../src/log.js";

test("redacts-token-query", () => assert.deepEqual(
  sanitizeForLog({ query: { token: "secret", defaultProvider: "codex" } }),
  { query: { token: "[REDACTED]", defaultProvider: "codex" } },
));

test("keeps-token-counts", () => assert.deepEqual(
  sanitizeForLog({ inputTokens: 12, outputTokens: 3 }),
  { inputTokens: 12, outputTokens: 3 },
));

test("redacts-url-and-bearer", () => assert.deepEqual(
  sanitizeForLog({ url: "https://x.test?token=abc123&defaultProvider=codex", authorization: "Bearer abc123" }),
  { url: "https://x.test?token=[REDACTED]&defaultProvider=codex", authorization: "[REDACTED]" },
));
