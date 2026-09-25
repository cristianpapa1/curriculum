# Onboarding — run as a conversation

Use this when you (the agent) onboard the user in chat instead of them running
`bun run onboard` in a terminal. Ask one group at a time, in the user's
language. Explain *why* each question matters in one sentence — every one of
them is something a real application form asked and a CV does not answer.

Write each answer to the file named. `examples/corpus/` holds the annotated
templates and `test/fixtures/corpus/` a filled-in example (an invented persona).
Never echo a secret back to the user, never write one anywhere but `.env`.

## 0. Before you start

- Run `bun run doctor` and fix what it reports.
- Create `Corpus/` if missing. Copy `defaults/form-answers.json` into it — those
  answers are generic and apply to any candidate; the user's own facts are added
  below as you collect them.

## 1. Identity → `Corpus/profile.yaml` `identity`, and `.env`

Full legal name, application email, phone in international format, city/state/
country, time zone, LinkedIn, GitHub and website (optional).
Also set `.env`: `APPLICANT_FULL_NAME`, `APPLICANT_EMAIL`, `APPLICANT_PHONE`,
`APPLICANT_LOCATION`, `APPLICANT_LINKEDIN`, `APPLICANT_GITHUB`, `APPLICANT_WEBSITE`.
`chmod 600 .env`.

## 2. Work authorization → `profile.yaml` `eligibility`

*Why:* "Will you require sponsorship?" eliminates more applicants than any
other question, and a wrong answer is a false statement.

- Citizenships and passports; which one forms should be told about first
  (`declare_passport`).
- Country of residence.
- `authorized_to_work`: the citizenship countries, plus "European Union" and
  "European Economic Area" for any EU citizen.
- `requires_sponsorship_for`: where they would need a visa (commonly US, UK, CA).
- For EU citizens: `eu_work_authorization_statement` (CV line) and
  `work_authorization_letter` in each document language (letter sentence).

## 3. Languages → `profile.yaml` `languages`

Each language with a CEFR level or "Native", and whether it is certified.
Forms offer their own scales ("Advanced", "Fluent", "I'm fluent: I can lead
meetings…"); the pipeline maps to them, but only from what is stated here.

## 4. Education → `profile.yaml` `education`

Institution, degree, discipline, **start month and year, end month and year**,
status (`completed` / `in_progress`), and a `form` block: `level`
(`bachelor` / `technical_high_school`), `discipline` names as dropdowns list
them (in each language), `school` search terms.

*Why months:* Greenhouse education blocks require them. A month the user does
not know stays empty — the form waits for them; it is never guessed.

## 5. Employment → `profile.yaml` `employment`

Employer, official title, start `YYYY-MM`, end `YYYY-MM` or `current: true`,
and a one-line context. Ask whether they have ever worked at a company they
might apply to (`declarations.worked_at_target_companies`).

## 6. Level by field → `profile.yaml` `self_assessed_seniority`

*Why:* forms ask "which seniority do you identify with", and people are often
senior in one field and junior in another.
Ask their level (junior / pleno / senior) for: `it` (operations, infra,
support), `iam`, `security`, `fullstack`, `other`.
Then which levels to **target** per field → `preferences.yaml`
`targeting.focus_levels`: `any`, `up_to_senior` or `junior`.

## 7. Where they would work → `preferences.yaml` `home`, `relocation`

Home city and the cities they could commute to (`home.cities`); other cities in
their country they would move to (`relocation.within_country`); whether they
would move abroad (which eligibility paths to enable when preparing).

## 8. Compensation → `profile.yaml` `current_contract`, `preferences.yaml` `compensation`

- Current contract type, monthly pay (optional — forms that require it stay
  waiting if absent), benefits, variable pay.
- Expected pay policy: always a number, or "negotiable" where a form allows
  (`prefer_avoidance`). Optional ceilings per level (`caps`) so the expectation
  never reads as a mismatch next to the current pay.

## 9. Voluntary questions and declarations → `profile.yaml`

- `self_identification`: disability (`none` / `yes` / `decline`). Everything
  else demographic is declined unless they volunteer an answer.
- `declarations`: protected veteran, public office held, relatives at target
  companies. A declaration left out is never answered.
- Tell them: criminal-record questions always come back to them.

## 10. Standing answers → `preferences.yaml` `answers`

Start availability ("In 2 weeks"), default "how did you hear" (never
"referral"). Add form-wide answers to `Corpus/form-answers.json` only when every
form asking that question should get the same answer.

## 11. Identifiers (optional) → `.env` only

National ID (`APPLICANT_CPF` for Brazilian forms), postal address
(`APPLICANT_ADDRESS_STREET`, `_DISTRICT`, `_CITY`, `_STATE`, `_POSTAL`,
`_COUNTRY`). Ask them to paste these directly into `.env` if they prefer you
never see them.

## 12. Mailbox (optional) → `.env`

Explain the scope exactly: some forms email an 8-character code; with IMAP
access the pipeline reads **only** those code emails, never prints or stores
them. Use an app password, never the real one (Google:
myaccount.google.com/apppasswords). Keys: `MAIL_IMAP_USER`, `MAIL_APP_PASSWORD`.
Ask them to paste the password into `.env` themselves.

## 13. Autonomy → `preferences.yaml` `autonomy`

`review` (they approve each application) or `auto` (applications passing every
gate are approved); a daily cap. The 24-hour per-company cooldown is fixed.

## 14. Corpus, then completion

Build `Corpus/claims.yaml` from their CV ([corpus.md](corpus.md)). Then:

```bash
bun run onboard --check
bun run onboard --complete --autonomy <review|auto> [--mailbox-consent]
bun run doctor
```
