# Working on this repository

Curriculum is a job-application agent: it discovers postings through job-board
APIs, tailors a CV and cover letter from a verified career corpus, fills and
submits application forms, and keeps a ledger. The agent skill that operates it
lives in `skills/curriculum/` — read `skills/curriculum/SKILL.md` before
running the pipeline for a user.

## Tooling

- Bun and TypeScript only — never npm, npx or Python.
- `bun run typecheck` and `bun test`. The `*.browser.test.ts` files launch
  Firefox; run them one at a time or they time out.
- CLI: `bun run src/cli.ts <scan|prepare|approve|submit|mark|ledger>`. `submit` is a
  dry run unless given `--live`, and `--live` is locked until onboarding is done.
- After editing `skills/curriculum/`, run `bun run scripts/sync-skill.ts`.

## Data boundaries

- `Corpus/`, `Applications/`, `logs/`, `.env` and every `.browser-profile*` are
  personal and git-ignored. Never commit them, quote them in code comments, or
  copy them into tests.
- Tests use the invented persona in `test/fixtures/corpus/` (set by `test/setup.ts`),
  never a real person's data. `examples/corpus/` holds the blank templates a new
  user fills in, and `defaults/form-answers.json` the generic form answers
  onboarding seeds.
- Identifiers and secrets live only in `.env`; reports show them masked.
- The mailbox is read only for application security codes: never print, log or
  store an email body.

## Behaviour that must not regress

- Truth: generated prose passes the anti-fabrication gate (`src/position/antifab.ts`);
  form answers come from the corpus or from facts the user stated. Unknown facts
  block the form — they are never guessed.
- Never bypass captchas or bot protection; those boards produce manual packs.
- One application per company per 24 hours (`companyCooldown`); stop on spam signals.
- Voluntary demographics are declined unless the user stated them; criminal-record
  questions are never answered automatically.
- Nothing personal is hard-coded: the candidate's policy is read from the corpus
  (`src/corpus/policy.ts`).

## Style

Match the surrounding code. Comments explain *why* — usually the real form
behaviour that made the code necessary — and a behaviour change comes with a
regression test that names that behaviour.
