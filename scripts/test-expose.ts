import { collectWebPorts, normalizeFunnelPath, withPath } from "../src/expose.js";

const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "✅" : "❌"} ${name}: ${JSON.stringify(got)}`);
  if (!ok) process.exitCode = 1;
};

t("funnel-subtree-path", normalizeFunnelPath("/eb/demo"), "/eb/demo/");
t("funnel-subtree-path-sloppy", normalizeFunnelPath("eb/demo///"), "/eb/demo/");
t("funnel-root-path", normalizeFunnelPath("/"), "/");
t("public-base-preserves-subtree-slash", withPath("https://demo.ts.net", "/eb/demo/"), "https://demo.ts.net/eb/demo/");
t("web-funnel-port-only", [...collectWebPorts({
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
})], [8443]);
