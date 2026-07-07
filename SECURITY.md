# Security

even-better exposes an HTTP/SSE endpoint that can drive a coding agent — i.e. it
can **run code on your machine** — guarded by a bearer token. Treat the endpoint
like a shell.

## Running it safely

- The token is process-local by default: a fresh token per launch unless you set
  `BRIDGE_TOKEN`. It is compared with a timing-safe check.
- On a trusted home LAN the default direct QR is fine. On an untrusted network,
  use `BIND_HOST=tailscale` so the port is never exposed to the LAN and the token
  never travels in the clear.
- Public tunnel modes (`PUBLIC_ACCESS=…`) put the endpoint on the internet behind
  only the token — prefer a named tunnel with its own auth (e.g. Cloudflare
  Access) for anything long-lived.
- Prompts from the glasses are typed into your live agent pane, so the usual
  prompt-injection considerations for coding agents apply.

## Reporting a vulnerability

Please report security issues privately via a
[GitHub security advisory](https://github.com/pawaca/even-better/security/advisories/new)
rather than a public issue. We'll acknowledge and work on a fix as fast as we can.
