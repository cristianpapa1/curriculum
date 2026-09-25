# The daily loop in detail

## 1. Discover and prepare

`prepare` fetches postings, filters them by eligibility and fit, scores them
against the corpus, renders the CV and letter (Markdown, HTML, PDF) and files
each application under `Applications/<date>_<company>_<role>/` with status
`prepared`. Nothing is sent.

```bash
bun run src/cli.ts prepare --targets greenhouse:acme,ashby:globex   # specific boards
bun run src/cli.ts prepare --from-registry --registry-limit 60       # boards in Companies/registry.yaml
bun run src/cli.ts prepare --targets "gupy:<search term>"            # Gupy (Brazil) is search-based
```

| Flag | Effect |
|---|---|
| `--paths a,b` | Eligibility lanes: `remote-brazil-eligible`, `brazil-local`, `relocation-europe`, `relocation-us` |
| `--title <regex>` | Only titles matching |
| `--min-score N` | Skip weak matches (junior postings often score low: they name few technologies) |
| `--per-company N` | Cap per employer (default 3) |
| `--focus-only` | Skip postings above the target level per field (`targeting.focus_levels`) |
| `--us-entry-only` | Visa-sponsored roles (US, UK) only at entry level |
| `--allow-sponsorship` | Include roles that need a work visa |

Gates applied before scoring: level (no staff/principal/management titles in
any language), languages named in the title, posting language, citizenship or
clearance requirements, postings reserved for a group, business functions with
"IT" in the title, new-graduate programmes the user is not eligible for, and
engineering outside software/infra/security.

`bun run scripts/refilter-push.ts [--apply]` re-applies the gates to prepared
applications after a rule changes. `bun run scripts/rerender.ts [--apply]`
re-renders unsent documents after the corpus or renderers change (the reviewed
version is kept in `previous-draft/`).

## 2. Dry run

```bash
DRYRUN_PROFILE_DIR=.browser-profile-dryrun bun run src/cli.ts submit --ats greenhouse --limit 30 > logs/dryrun.log
bun run scripts/readiness.ts logs/dryrun.log
```

The dry run fills each form completely and stops before the button. It writes
`form-questions.json` (every question, its options, whether it is answered)
into the application folder. **Use one browser profile per concurrent run** —
two runs on one profile fail to launch.

## 3. Answering what the generic fillers cannot

Per-form answers go in `Applications/<folder>/answers.json`; answers every form
should share go in `Corpus/form-answers.json`.

```json
[
  { "q": "Do you require relocation for this role?", "a": "No, I don't require relocation", "why": "lives in the city of the role" },
  { "q": "What is your level of English", "a": ["I'm fluent: I can lead meetings…"], "why": "C1 certified (profile.yaml)" }
]
```

- `q` — a case-insensitive fragment of the question. The most specific
  (longest) shared fragment answers first.
- `a` — text to type, or option labels to pick (a list = candidates in order).
  Short answers ("Yes") never select a longer option that says more than was
  decided; give the full option text for those.
- `why` — the corpus fact it rests on. Prose of 40+ characters passes the
  anti-fabrication gate.
- `requires: "certs"` — apply only when a certification relates to the posting.

Placeholders resolved per application: `__LEGAL_NAME__`, `__PREFERRED_NAME__`,
`__EMPLOYER__`, `__JOB_TITLE__` (profile), `__CPF__` (.env), `__CERTS__`
(certifications related to the posting, empty when none),
`__SENIORITY__` (the user's own level in the posting's field),
`__APPLIED_BEFORE__` (Yes only if the pipeline already applied to that company).

Before writing an answer to a dropdown, read its real options:
`bun run scripts/probe-options.ts --full <apply-url>`.

## 4. Approve and send

```bash
bun run src/cli.ts approve <id>,<id>
bun run src/cli.ts submit --live --ats greenhouse --limit 30
```

Live runs send only `approved` applications whose every required field is
answered. After the click, success needs a *new* confirmation on the page; a
refusal needs a *new* error. Greenhouse security-code prompts are answered from
the mailbox (if consented) by the code email naming the company — or the only
fresh code email when the company mails under another name.

Per company: one attempt per 24 hours. A refusal over a missing field does not
count (nothing was stored); an ambiguous outcome does. Any spam or rate-limit
message stops the whole run.

## 5. Boards submitted by hand

Lever (hCaptcha), SmartRecruiters (DataDome), Ashby (spam check) and Gupy
(login and multi-step flow) are never automated. `bun run scripts/manual-pack.ts`
writes a `MANUAL-SUBMIT.md` per approved application — apply link, files, every
answer, the letter text — and `MANUAL-INDEX.md` ranked by match score, split
into the user's focus and the rest.

## 6. Records

`bun run src/cli.ts ledger` lists applications and response rates by angle.
`bun run src/cli.ts mark <id> <screening|interview|rejected|offer>` records
replies. `bun run scripts/withdraw.ts "<company regex>" "<reason>" [--title <regex>]`
withdraws unsent applications (closed postings, wrong fit).
