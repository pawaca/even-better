#!/usr/bin/env python3
"""Score a simulator recording against the three goals:
1. coverage  — every expected marker appears in the received stream
2. no dupes  — no normalized line is received more than once
3. no noise  — nothing matching known-volatile families leaks through
Usage: analyze-sim.py <sim.jsonl> <marker1> [marker2 ...]
"""
import json
import re
import sys
from collections import Counter

sim_file = sys.argv[1]
markers = sys.argv[2:]

events = []
with open(sim_file) as f:
    for line in f:
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass

sse = [e["payload"] for e in events if e["kind"] == "sse"]
deltas = [m for m in sse if isinstance(m, dict) and m.get("type") == "text_delta"]
all_text = "\n".join(d["text"] for d in deltas)

print(f"SSE events: {len(sse)}  deltas: {len(deltas)}  chars: {len(all_text)}")
print(f"event types: {dict(Counter(m.get('type') for m in sse if isinstance(m, dict)))}")

# 1. coverage
missing = [m for m in markers if m not in all_text]
print(f"\n[goal-1 coverage] {len(markers) - len(missing)}/{len(markers)}")
for m in markers:
    print(f"  {'OK ' if m not in missing else 'MISS'} {m}")

# 2. duplicates (normalized: strip bullet prefix + whitespace collapse).
# Rules: replay burst (first 2s after connect) is excluded — replay + live
# legitimately overlap across turns. Pure box-drawing lines are exempt (table
# borders repeat by design). A dupe counts only when two live arrivals of the
# same normalized line are within 120s (≈ same turn).
def norm(l: str) -> str:
    l = re.sub(r"^\s*⏺\s*", "", l.strip())
    return re.sub(r"\s+", " ", l)

BOX = re.compile(r"^[│├┼┤┌┬┐└┴┘─═╌\s]+$")
delta_events = [e for e in events if e["kind"] == "sse"
                and isinstance(e["payload"], dict) and e["payload"].get("type") == "text_delta"]
import datetime
def ts(e):
    return datetime.datetime.fromisoformat(e["t"].replace("Z", "+00:00")).timestamp()
t0 = ts(events[0]) if events else 0
live = [e for e in delta_events if ts(e) - t0 > 2.0]
seen: dict[str, float] = {}
dupes = []
for e in live:
    for l in e["payload"]["text"].split("\n"):
        if not l.strip() or BOX.match(l):
            continue
        n = norm(l)
        if n in seen and ts(e) - seen[n] < 120:
            dupes.append((n, ts(e) - seen[n]))
        seen[n] = ts(e)
print(f"\n[goal-2 dupes] {len(dupes)} intra-turn repeated lines (live stream)")
for l, gap in dupes[:8]:
    print(f"  +{gap:.0f}s {l[:80]!r}")

# 3. noise
NOISE = [
    (re.compile(r"^[✢✳✶✻✽∗·]\s"), "spinner"),
    (re.compile(r"\(esc to"), "esc-hint"),
    (re.compile(r"^⏺$"), "lone-bullet"),
    (re.compile(r"…\s*\(\d+m?\s?\d*s\)?\s*$"), "duration-suffix"),
    (re.compile(r"^\s*>\s"), "prompt-echo"),
    (re.compile(r"tokens\)"), "token-counter"),
    (re.compile(r"bypass permissions"), "status-bar"),
    (re.compile(r"shift\+tab"), "status-bar"),
]
lines = [norm(l) for d in deltas for l in d["text"].split("\n") if l.strip()]
noise = []
for l in lines:
    for pat, name in NOISE:
        if pat.search(l):
            noise.append((name, l))
            break
print(f"\n[goal-3 noise] {len(noise)} noisy lines")
for name, l in noise[:8]:
    print(f"  [{name}] {l[:80]!r}")

ok = not missing and not dupes and not noise
print(f"\nRESULT: {'PASS' if ok else 'FAIL'}")
sys.exit(0 if ok else 1)
