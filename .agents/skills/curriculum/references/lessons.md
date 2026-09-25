# Lessons from real application forms

Each of these broke a real application. The fix is in the code; the lesson is
here so an agent recognises the pattern when a new form shows it.

## Reading forms

- **React-select dropdowns are not text boxes.** Greenhouse location, school,
  degree, month and most custom questions are react-select widgets. Type to
  filter, then click an option *of that widget* — its options are named after
  the input id (`react-select-<id>-option-N`).
- **The phone-country list is always in the DOM.** An unscoped search for
  options finds "Afghanistan +93…" and clicks the wrong thing. Scope every
  option lookup to the widget that owns it.
- **The control's text includes its placeholder.** "Select…" made every empty
  dropdown look answered. Only the value element counts.
- **React-select has an `aria-hidden` twin input** used for native validation.
  Typing into it fakes an answer while nothing is selected. Skip it.
- **Disabled fields are not questions.** "Current role" disables the end-date
  fields but leaves them marked required.
- **Two fields can share a title.** One form asked "Demographic Information*"
  twice; merged into one question, only the first was answered.
- **Employment and education blocks share labels** ("Start date month"). Fill
  them by field id (`start-date-month-0` vs `start-month--0`), never by label.

## Choosing answers

- **A negated option must not satisfy the word it negates.** "Fluent" matched
  "…but I don't speak English fluently" and understated the candidate by two
  levels. A match after "not / don't / never" in the same clause is rejected.
- **A short answer must not select a longer claim.** "Yes" matched "Yes, I'm
  based in or near Paris" — a false statement. Short answers need an exact or
  unique match; otherwise give the full option text.
- **The most specific answer wins.** A generic "Privacy Notice → Yes" took a
  question whose only option was "Confirmed". Shared answers are tried longest
  fragment first.
- **Read the options before writing the answer.** Half of all "no option
  matched" were answers written blind: "BRA (+55)", "I Agree", "Não sou PCD",
  "Question does not apply to me".
- **Expectation is not current pay.** A salary filler must never type an
  expected figure into "current salary".
- **Uploads go only where a CV or letter is asked for.** A second "Attach" on a
  Portuguese form was for a disability medical report; the CV went there.
- **The same question is worded differently on every board.** "Who is your
  current or previous employer?" and "…current or most recent employer?" are one
  question; a shared answer must key on the fragment they share.
- **Standard questions are not standard outside the US.** "I am not a protected
  veteran" is US wording; European forms offer "Not a veteran" or "No, I have
  never served in the Armed Forces". Give a shared answer several candidates.
- **Demographics can be required.** Some EU forms mark gender, ethnicity and
  even an age range with `*`. They still carry a decline option — take it rather
  than stating something the user never said.

## Sending

- **Confirmation must be new.** "Thank you for applying" text or a "* required"
  marker already on the page is not an outcome. Compare counts before and after
  the click.
- **Security-code prompts are localized** ("Um código de verificação foi
  enviado…"), while the email stays English. Detect the prompt in every language.
- **Companies mail under other names.** A company renamed since the ledger was
  written never matches the email subject. Keep the rename in
  `preferences.yaml` (`mail.company_aliases`), and accept the single fresh code
  email when nothing names the company.
- **Bot protection means stop.** hCaptcha, DataDome and a "flagged as possible
  spam" response are the site saying no to automation. Their own advice —
  change network, browser or device — is evasion. Those boards become manual.
- **One company per 24 hours.** Rapid repeat submissions triggered spam flags on
  one board. A refusal over a missing field does not count against the window;
  an ambiguous outcome does.

## Choosing postings

- **Coverage is not fit.** Staff, principal and management titles (in every
  language: *gerente*, *coordenador*, *líder*, *jefe*) score well and are
  near-certain rejections below that level.
- **A state is not a city.** "Campinas, São Paulo, Brasil" is Campinas;
  "Porto Alegre" is not Porto, Portugal.
- **"IT" in a title is not IT work.** "Analista Financeiro TI" is finance.
- **Programmes have audiences.** SkillBridge is for US service members; new-grad
  programmes want a recent degree; affirmative postings are for their group —
  set them aside, never infer membership.
- **Postings close.** A board returning 404 for a job id means withdraw it.
- **Long paths break PDFs on WSL.** Windows Chrome cannot write paths over 260
  characters; file names are shortened to fit.
