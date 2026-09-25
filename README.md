# Curriculum

**An agent skill that searches and applies for jobs for you — and refuses to
lie, to spam, or to get around bot protection.**

Give it your CV once. It finds postings on company job boards, tailors a CV and
a cover letter to each one from evidence you verified, fills the application
form, and sends it. Where a site challenges automation, it hands you a
ready-to-send pack instead. It works as a skill for **Claude** (Claude Code) and
**OpenAI Codex**, or from the command line on its own.

It was built by applying for real: the rules and safeguards below each come from
a form that broke, a question the CV could not answer, or a site that said no.

## What it does

- **Discovers** postings on Greenhouse, Lever, Ashby, SmartRecruiters, Workable
  and Gupy, from a registry of 1,100+ companies or boards you name.
- **Filters** by what a recruiter checks first: level, location and visa,
  languages, citizenship or clearance requirements, reserved programmes.
- **Scores** each posting against your evidence and picks the angle — security,
  DevOps, IAM, cloud, full stack, AI — that your record supports best.
- **Tailors** a CV and cover letter (Markdown, HTML, PDF; English, Portuguese,
  Spanish), naming your certifications only when they relate to the job.
- **Fills** the whole form — including education and employment blocks,
  dropdowns, screeners and location autocompletes — and records every question.
- **Submits** Greenhouse applications automatically, reading the emailed
  security code if you allow it; prepares manual packs for everything else.
- **Keeps a ledger** of every application, its documents, its answers and the
  proof of submission.

## The rules it never relaxes

1. **Truth only.** Every sentence traces to your corpus. An anti-fabrication gate
   rejects any number, technology or scope your evidence does not support. A
   truthful "No" is answered "No".
2. **It asks, it never guesses.** Degree months, salary, disability, relatives, a
   past application — if you have not stated it, the form waits for you.
3. **No bot-protection bypass.** Captchas and spam checks mean *stop*; those
   boards become manual packs.
4. **One application per company per 24 hours**, and a full stop on any spam
   signal.
5. **Your identifiers stay local.** National ID, address and passwords live in
   `.env` (mode 600), masked in every report, never committed.
6. **The mailbox is read only for application security codes**, only with your
   consent.
7. **Nothing is sent before onboarding.** Live submission is locked until you
   have answered, once, the questions no CV answers.

## Quick start

```bash
curl -fsSL https://bun.sh/install | bash          # Bun
git clone https://github.com/cristianpapa1/curriculum
cd curriculum
bun install
bunx playwright install firefox                    # the browser that fills forms
bun run doctor                                     # checks everything, prints fixes
```

A PDF engine is also needed: Chrome or Chromium. On WSL, Chrome installed on
Windows is found automatically.

### As a skill

**Claude Code**

```
/plugin marketplace add cristianpapa1/curriculum
/plugin install curriculum@curriculum
```

Or just open the cloned repository in Claude Code: the skill ships in
`.claude/skills/curriculum/`.

**OpenAI Codex**

Open the cloned repository: Codex reads skills from `.agents/skills/`. To use it
from anywhere, copy `skills/curriculum` to `~/.agents/skills/curriculum`.

Then ask: *"Set me up to apply for jobs."* The agent runs the environment check,
onboards you in conversation, builds your corpus from your CV with you, and
only then starts applying.

### By hand

```bash
bun run onboard                                    # the questionnaire (re-run to change answers)
# build Corpus/claims.yaml from your CV — see skills/curriculum/references/corpus.md
bun run onboard --check                            # what is still missing
bun run src/cli.ts prepare --from-registry --limit 20
DRYRUN_PROFILE_DIR=.browser-profile-dryrun bun run src/cli.ts submit --ats greenhouse --limit 20
bun run src/cli.ts approve <id>,<id>
bun run src/cli.ts submit --live --ats greenhouse
bun run scripts/manual-pack.ts                     # MANUAL-INDEX.md for the boards sent by hand
```

## Onboarding: the questions a CV does not answer

Every one of these was asked by a real form, and a wrong guess would be a false
statement on the candidate's behalf:

| Topic | Why forms need it |
|---|---|
| Citizenships, residence, where you need a visa | "Will you require sponsorship?" eliminates more applicants than any other question |
| Education and employment **months** | Structured blocks require them |
| Your level **per field** | "Which seniority do you identify with?" — many people are senior in one field, junior in another |
| Home cities and where you would move | Hybrid and onsite roles |
| Current pay, contract type, benefits; expectation policy | Current and expected pay sit side by side on the same form |
| Disability, demographics | Declined unless you choose to answer |
| Veteran, public office, relatives, past employers | Declarations — never assumed |
| National ID, address | Some forms require them; stored only in `.env` |
| Mailbox access | Only for emailed security codes |
| Autonomy | You approve each application, or gates approve them |

## Boards

| Board | Discovery | Submission |
|---|---|---|
| Greenhouse | ✓ | automatic (including emailed security codes) |
| Ashby | ✓ | manual pack — Ashby flags automated submissions as spam |
| Lever | ✓ | manual pack — hCaptcha |
| SmartRecruiters | ✓ | manual pack — DataDome |
| Workable | ✓ | automatic, experimental — not yet exercised on a live form |
| Gupy (Brazil) | ✓ search | manual pack — candidate login |

## Your data

```
Corpus/                your profile, evidence claims, policy and standing answers (never committed)
.env                   identifiers and secrets, mode 600 (never committed)
Applications/          one folder per application: CV, letter, answers, proof (never committed)
examples/corpus/       blank templates for each corpus file
defaults/form-answers.json  generic form answers, seeded into your corpus at onboarding
test/fixtures/corpus/  an invented persona the test suite runs against
Companies/registry.yaml  1,100+ companies and their job-board tokens
```

## Project layout

```
src/ats/          job-board adapters (fetch and normalise postings)
src/corpus/       corpus loader, validation, the candidate's policy
src/position/     positioning angles, claim projection, anti-fabrication gate
src/render/       CV and cover letter (Markdown, HTML, PDF; en/pt/es)
src/pipeline/     eligibility, fit, scoring, salary, forms, submission, mail codes
scripts/          onboarding, doctor, manual packs, dry-run readiness, maintenance
skills/curriculum the agent skill (copied to .claude/skills and .agents/skills)
test/             bun test — runs against the fictional example corpus
```

## Development

```bash
bun test                  # the *.browser.test.ts files launch Firefox: run them one at a time
bun run typecheck
bun run scripts/sync-skill.ts   # after editing skills/curriculum
```

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Read
[the form lessons](skills/curriculum/references/lessons.md) first: most bugs here
are a form behaving in a way nobody expected.

## Limitations

- The region model is tuned for a candidate living in **Brazil** (with optional
  EU citizenship): remote roles are judged by whether they accept Brazil/LATAM.
  Cities, relocation, salary bands and levels are configurable; making the home
  country itself configurable is the most wanted contribution.
- Only Greenhouse is submitted automatically.
- Salary bands are estimates to tune in `preferences.yaml`, not survey data.

## Responsible use

Apply only to roles you would take, with facts that are true. Respect each
site's terms. The pipeline is rate-limited and stops at bot protection by
design; do not remove those safeguards. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
