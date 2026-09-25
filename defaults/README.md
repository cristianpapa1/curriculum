# Default form answers

`form-answers.json` is copied into `Corpus/form-answers.json` at onboarding, as
the starting set of answers every application form gets.

Only answers that are true for **any** candidate belong here:

- **Placeholders** resolved per application — `__EMPLOYER__`, `__JOB_TITLE__`,
  `__LEGAL_NAME__`, `__PREFERRED_NAME__`, `__CERTS__`, `__SENIORITY__`,
  `__APPLIED_BEFORE__`, `__CPF__`.
- **The never-referral rule.** A referral nobody can confirm is a claim that
  fails the moment a recruiter checks it.
- **Voluntary demographics**, declined — gender, race, orientation,
  neurodiversity. An answer is given only when `profile.yaml`
  `self_identification` states one.
- **Consents and acknowledgements** a form requires before it will submit.

Anything that states a fact about a person — a language level, a disability, a
relative at the company, a certification, a salary — does **not** belong here.
Those come from the corpus (`profile.yaml`, `claims.yaml`) or from the user's
own `Corpus/form-answers.json`, so the pipeline never answers on someone's
behalf with a fact that is not theirs.
