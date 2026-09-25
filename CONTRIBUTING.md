# Contributing

Thanks for helping. A few conventions keep this project trustworthy.

- **Bun and TypeScript only.** `bun install`, `bun test`, `bun run typecheck`.
- **Tests run against an invented persona** (`test/fixtures/corpus/`) — never a
  real candidate's data.
  Never add real personal data to a test, a fixture, a comment or an example.
- **Every behaviour change carries its reason.** Most code here exists because a
  real form behaved unexpectedly; say which form behaviour, in a comment and a
  regression test.
- **Safeguards are not negotiable.** Pull requests that bypass captchas or bot
  checks, weaken the anti-fabrication gate or remove rate limits will not be
  merged.
- **Skill edits happen in `skills/curriculum/`**, then run
  `bun run scripts/sync-skill.ts` to refresh the copies Claude Code and Codex
  read.

Wanted: a configurable home country (the region model is Brazil-first), more
job boards with automatic submission, more document languages.
