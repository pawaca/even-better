import { test } from "node:test";
import assert from "node:assert/strict";
import { collectWebPorts, normalizeFunnelPath, withPath } from "../src/expose.js";

test("funnel-subtree-path", () => assert.deepEqual(normalizeFunnelPath("/eb/demo"), "/eb/demo/"));
test("funnel-subtree-path-sloppy", () => assert.deepEqual(normalizeFunnelPath("eb/demo///"), "/eb/demo/"));
test("funnel-root-path", () => assert.deepEqual(normalizeFunnelPath("/"), "/"));
test("public-base-preserves-subtree-slash", () => assert.deepEqual(withPath("https://demo.ts.net", "/eb/demo/"), "https://demo.ts.net/eb/demo/"));
test("web-funnel-port-only", () => assert.deepEqual([...collectWebPorts({
  Foreground: {
    node: {
      TCP: {
        "443": { TCPForward: true },
        "8443": { HTTPS: true },
      },
      Web: {
        "demo.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3456" } } },
      },
    },
  },
})], [8443]));
