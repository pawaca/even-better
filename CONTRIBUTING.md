# Contributing

Thanks for your interest in even-better.

## Development

No build step — everything runs through [`tsx`](https://github.com/privatenumber/tsx).

```bash
pnpm install
pnpm start        # run the server (prints a QR code)
pnpm check        # tsc --noEmit — must pass before every commit
pnpm test         # run the unit suites in scripts/
```

Both `pnpm check` and `pnpm test` run in CI on every pull request.

## Ground rules

- **Strict TypeScript.** `any` is forbidden — use `unknown` + narrowing.
- **ESM only** — import with the `.js` extension (`import … from "./x.js"`).
- Match the surrounding style; keep changes surgical.
- Add or update the relevant `scripts/test-*.ts` when you touch a pure function.

## How it fits together

- `docs/ARCHITECTURE.md` — the map of the codebase and *why* the seams are where
  they are. Read it before any structural change.
- The other `docs/` references cover the external contracts — multiplexer
  sockets, session transcripts, the even-terminal protocol, and the permission
  flow.
- `AGENTS.md` — instructions for AI coding agents working in this repo
  (`CLAUDE.md` is a symlink to it). Not required reading for humans.

## Commits & PRs

Conventional commits (`feat:` / `fix:` / `refactor:` / `docs:` / `chore:`).
Keep a PR to one topic; make sure `pnpm check` and `pnpm test` pass first.
