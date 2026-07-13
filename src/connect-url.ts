// Print the connect URL without leaking the bearer token into the terminal (scrollback,
// screen-share, captured logs). The full URL — with the token — goes ONLY into the QR, which
// is the intended one-scan connect path; the human-readable line shows a token-redacted URL.
// The full URL is printed in plaintext only when there is no QR to scan, or SHOW_TOKEN=1 is
// set for camera-less manual entry. Shared by index.ts (LAN/local) and expose.ts (tunnels).

import qrcodeTerminal from "qrcode-terminal";

/** The URL with its `token` query value redacted — safe for human-readable logs. */
export function redactToken(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("token")) u.searchParams.set("token", "…");
    return u.toString();
  } catch {
    return url;
  }
}

/** First4…last4 of a token, so the Token line identifies it without printing the secret. */
export function maskToken(t: string): string {
  return t.length > 8 ? `${t.slice(0, 4)}…${t.slice(-4)}` : "…";
}

/** Print a connect line: a token-redacted URL for humans + the QR carrying the full token.
 *  The full URL is printed only with no QR (nothing to scan) or SHOW_TOKEN=1 (manual entry). */
export function printConnect(label: string, fullUrl: string, qrEnabled: boolean): void {
  const showToken = process.env.SHOW_TOKEN === "1";
  console.log(`  ${label} · ${redactToken(fullUrl)}`);
  // The QR encodes the FULL URL (token included). Write it straight to the terminal, NOT via
  // console.log — the diag-log tee wraps console.* and would persist the QR's glyphs to disk,
  // where the token is still decodable even though the printed URL is redacted.
  if (qrEnabled) qrcodeTerminal.generate(fullUrl, { small: true }, (code) => process.stdout.write(code + "\n"));
  if (!qrEnabled || showToken) console.log(`  Full URL · ${fullUrl}`);
  else console.log("  (the QR carries the token; set SHOW_TOKEN=1 to print the full URL)");
}
