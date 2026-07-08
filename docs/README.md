# Documentation

**Using even-better?** Start with the [project README](../README.md), then:

- **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** — runbooks for when the glasses
  show something wrong.

**Working on even-better?** These are the contributor references:

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — the map of the codebase and *why* the
  seams are where they are. Read it before any structural change.
- **[PROTOCOL.md](PROTOCOL.md)** — the even-terminal wire protocol: every event
  type, both directions, plus transport/resilience.
- **[MULTIPLEXERS.md](MULTIPLEXERS.md)** — the herdr and cmux socket/CLI contracts
  and how they map to the neutral `Multiplexer` interface.
- **[SESSIONS.md](SESSIONS.md)** — the Claude/Codex session-transcript (jsonl)
  fields even-better depends on.
- **[PERMISSIONS.md](PERMISSIONS.md)** — the permission/interaction flow (detect →
  present → respond) for both agents.

(`AGENTS.md` at the repo root holds instructions for AI coding agents;
`CLAUDE.md` is a symlink to it.)
