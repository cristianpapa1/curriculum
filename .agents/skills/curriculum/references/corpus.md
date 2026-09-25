# Building the career corpus from a CV

Every CV and letter is assembled from `Corpus/claims.yaml` and nothing else. The
anti-fabrication gate (`src/position/antifab.ts`) rejects any document sentence
that states a number, technology or scope no claim supports. So the corpus is
where truth is decided — build it carefully, with the user.

`examples/corpus/claims.yaml` is the annotated template, and
`test/fixtures/corpus/claims.yaml` a complete worked set for an invented
persona. Match their shape exactly.

## One claim = one verifiable achievement

```yaml
claims:
  - id: claim-idp-consolidation       # stable, kebab-case, never reused
    employer: <employment id>         # an id from profile.yaml employment, or null for independent work
    claim: >                          # the canonical sentence, past tense, verb first
      Consolidated three separate directories into a single Microsoft Entra ID
      tenant covering 900+ accounts, with one joiner-mover-leaver process for the
      whole company.
    variants:                         # optional re-emphasis per positioning angle
      security: >
        Removed three parallel directories as an attack surface, bringing 900+
        accounts under one tenant and one lifecycle process.
    domains: [iam, identity, security]  # domains[0] is what the claim is most about
    skills: ["Microsoft Entra ID", "IAM / RBAC"]
    metric: 900+ accounts             # null when the source states no number
    scope: company-wide identity directory
    strength: 5                       # 1-5: how differentiating in a competitive pool
    source: >                         # REQUIRED — a verbatim quote from the CV or artifact
      "Merged three directories into a single Microsoft Entra ID tenant (900+
      accounts) and defined the joiner-mover-leaver process used company-wide."
```

Variant keys are positioning angles: `iam`, `devops`, `devsecops`, `security`,
`compliance`, `cloud`, `ai`, `observability`, `fullstack`, `automation`,
`ai-fullstack`, `architecture`.

## The contract

- `source` quotes the original CV (or a verifiable artifact: a README, a public
  site, a commit count). The loader refuses a claim without one.
- `claim` and every variant may **re-word, re-order and re-emphasise** the
  source. They may **not** add a fact, a number, a technology or a scope the
  source does not support. "Led" is not "helped"; "400+" is not "500".
- A skill in `skills:` must also be declared in `profile.yaml` `skills` at an
  honest level. The pipeline never claims a level above the declared one.
- Things the user does **not** have go in `profile.yaml` `gaps`, so documents
  never imply them.

## Working with the user

1. Read the CV. Draft one claim per concrete achievement — usually 25–45.
2. Show the drafts grouped by employer, with the quoted source beside each.
   Ask the user to correct anything overstated, missing or wrong.
3. Ask for metrics the CV implies but does not state ("how many endpoints?").
   Record a number only if the user gives it, and quote them in `source`.
4. Optional: add Portuguese/Spanish translations of each canonical claim in
   `Corpus/i18n.yaml` (same shape as the example). A document is rendered in a
   language only when every claim it uses is translated; otherwise it falls back
   to English in full.
5. Validate: `bun run corpus` loads and checks the corpus; `bun run onboard
   --check` confirms there are enough claims.
