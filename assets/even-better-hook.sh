#!/bin/sh
# installed by even-better — reports Claude/Codex lifecycle events to even-better
# over a local unix socket. Managed file; reinstalling overwrites it.
#
# Shape follows herdr's herdr-agent-state.sh. The hard rule: this runs SYNCHRONOUSLY
# inside the agent's turn, so it MUST never block — short timeout, detached send,
# always exit 0 even when even-better is down (docs/HOOK-MIGRATION.md).
#
# Arg 1: agent label (claude|codex). Event name + fields come from the hook payload
# on stdin. Pane id comes from whichever mux set its env var.

set -eu

agent="${1:-claude}"
# capture the invoking (agent) pid before any subshell changes $PPID
agent_pid="${PPID:-0}"

# Read the agent's hook payload (stdin) into a temp file — NOT an env var: a large
# pasted prompt or tool input can exceed the ~128KiB env limit (E2BIG) and, under
# `set -e`, abort before `exit 0` and disrupt the turn. Mirrors herdr's
# HERDR_HOOK_INPUT_FILE.
payload_file="$(mktemp "${TMPDIR:-/tmp}/eb-hook.XXXXXX" 2>/dev/null)" || exit 0
trap 'rm -f "$payload_file"' EXIT HUP INT TERM
cat > "$payload_file" 2>/dev/null || true

sock="${EVEN_BETTER_HOOK_SOCKET:-$HOME/.even-better/hook.sock}"
[ -S "$sock" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

# env-primary pane id (prefer cmux's documented CMUX_SURFACE_ID); Phase 2 adds tmux
pane_id="${CMUX_SURFACE_ID:-${CMUX_PANEL_ID:-${HERDR_PANE_ID:-${TMUX_PANE:-}}}}"
[ -n "$pane_id" ] || exit 0

mux="unknown"
if [ -n "${CMUX_SURFACE_ID:-}" ] || [ -n "${CMUX_PANEL_ID:-}" ]; then
  mux="cmux"
elif [ -n "${HERDR_PANE_ID:-}" ]; then
  mux="herdr"
elif [ -n "${TMUX_PANE:-}" ]; then
  mux="tmux"
fi

# Timeout-bounded, error-swallowing send (synchronous, like herdr's reference — a
# tiny local socket write returns in ms even if even-better is down/hung: a missing
# socket fails the guard above, a refused/queued connect returns fast, and a small
# sendall goes to the kernel buffer without waiting for a reader; the 2s timeout is a
# backstop). fds are redirected off the agent's pipe so it never waits on us for EOF.
EB_AGENT="$agent" EB_MUX="$mux" EB_PANE="$pane_id" EB_SOCK="$sock" \
EB_PID="$agent_pid" EB_PAYLOAD_FILE="$payload_file" \
python3 - <<'PY' >/dev/null 2>&1
import json, os, socket, time

try:
    with open(os.environ.get("EB_PAYLOAD_FILE") or "/dev/null", encoding="utf-8") as f:
        payload = json.load(f)
except Exception:
    payload = {}
if not isinstance(payload, dict):
    payload = {}


def as_int(v, default=0):
    try:
        return int(v)
    except Exception:
        return default


report = {
    "agent": os.environ.get("EB_AGENT") or "claude",
    "mux": os.environ.get("EB_MUX") or "unknown",
    "paneId": os.environ.get("EB_PANE") or "",
    "event": str(payload.get("hook_event_name") or ""),
    "sessionId": payload.get("session_id"),
    "transcriptPath": payload.get("transcript_path"),
    "cwd": payload.get("cwd") or None,
    "pid": as_int(os.environ.get("EB_PID"), 0),
    "ts": int(time.time() * 1000),
    "seq": time.time_ns(),
    "toolName": payload.get("tool_name"),
}
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(2)
    s.connect(os.environ.get("EB_SOCK"))
    s.sendall((json.dumps(report) + "\n").encode("utf-8"))
    s.close()
except Exception:
    pass
PY

exit 0
