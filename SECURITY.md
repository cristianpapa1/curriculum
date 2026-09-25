# Security and responsible use

## Your data

- Everything personal stays on your machine. `Corpus/`, `Applications/`, `logs/`
  and `.env` are git-ignored; `.env` must be mode 600 (`bun run doctor` checks).
- National ID, postal address and passwords are read from `.env` only at the
  moment a form requires them, and are masked in reports and in the
  `form-questions.json` snapshots.
- Mailbox access (optional) exists only to read application security codes. The
  code never prints, logs or stores an email body. Use an app password.
- Before pushing a fork, scan your history for personal data. A pre-commit check
  that searches staged files for your own identifiers is a good idea.

## Using it responsibly

- Apply only with true facts. The anti-fabrication gate is a safety net, not a
  licence to feed it invented evidence.
- Keep the safeguards: one application per company per 24 hours, stop on spam
  signals, never bypass captchas or bot protection. Removing them harms the
  boards, the employers and the people applying honestly.
- Respect each job board's terms of service.

## Reporting a vulnerability

Open a private security advisory on GitHub (Security → Report a vulnerability)
rather than a public issue.
