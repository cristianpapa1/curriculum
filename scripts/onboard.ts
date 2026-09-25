#!/usr/bin/env bun
/**
 * Onboarding — the questions to answer once, before the agent applies for you.
 *
 * Every question here is one a real application form asked that a CV does not
 * answer, and that the agent must never guess: which passport, which cities,
 * which months, what salary, which level in which field, what to say about
 * disability, whether it may read your mailbox. The answers are written to
 * Corpus/ (your profile and policy) and .env (identifiers and secrets, mode
 * 600). Nothing leaves your machine.
 *
 *   bun run onboard            interactive questionnaire (re-run to change answers)
 *   bun run onboard --check    list what is still missing
 *   bun run onboard --complete --autonomy review|auto [--mailbox-consent]
 *                              record completion after an agent-led onboarding
 *
 * `submit --live` refuses to run until onboarding is complete.
 */

import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT, CORPUS_DIR } from "../src/corpus/load.ts";
import { onboardingGaps, writeOnboardingRecord, onboardingRecord } from "../src/pipeline/onboarding.ts";

const DEFAULT_ANSWERS = join(PROJECT_ROOT, "defaults", "form-answers.json");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => args[args.indexOf(`--${name}`) + 1];

async function report(): Promise<number> {
  const gaps = await onboardingGaps();
  if (gaps.length === 0) {
    console.log("✓ Nothing missing.");
    return 0;
  }
  for (const g of gaps) console.log(`${g.severity === "block" ? "✗" : "!"} ${g.detail}`);
  const blocking = gaps.filter((g) => g.severity === "block").length;
  console.log(blocking ? `\n${blocking} item(s) block live submission.` : "\nNothing blocks live submission; the warnings stop individual forms.");
  return blocking;
}

// ── --check ────────────────────────────────────────────────────────────────
if (flag("check")) process.exit((await report()) ? 1 : 0);

// ── --complete (agent-led onboarding finished) ─────────────────────────────
if (flag("complete")) {
  const autonomy = value("autonomy");
  if (autonomy !== "review" && autonomy !== "auto") {
    console.error("usage: onboard --complete --autonomy review|auto [--mailbox-consent]");
    process.exit(1);
  }
  if (await report()) process.exit(1);
  await writeOnboardingRecord({ autonomy, mailboxConsent: flag("mailbox-consent") });
  console.log(`\nOnboarding recorded (autonomy: ${autonomy}). Live submission is unlocked.`);
  process.exit(0);
}

// ── Interactive questionnaire ──────────────────────────────────────────────
if (!process.stdin.isTTY) {
  console.error("Run `bun run onboard` in a terminal, or let your agent run the skill's onboarding and then `--complete`.");
  process.exit(1);
}

const readYaml = async (dir: string, file: string) => {
  const f = Bun.file(join(dir, file));
  return (await f.exists()) ? Bun.YAML.parse(await f.text()) : null;
};
const profile: any = (await readYaml(CORPUS_DIR, "profile.yaml")) ?? {};
const prefs: any = (await readYaml(CORPUS_DIR, "preferences.yaml")) ?? {};
const envText = await Bun.file(join(PROJECT_ROOT, ".env")).text().catch(() => "");
const env: Record<string, string> = Object.fromEntries(
  envText.split("\n").map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m![1]!, m![2]!]),
);

const section = (title: string, why: string) => console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}\n${why}\n`);
const ask = (q: string, current?: string | number | null): string => {
  const shown = current !== undefined && current !== null && `${current}` !== "" ? ` [${current}]` : "";
  const a = prompt(`${q}${shown}:`)?.trim() ?? "";
  return a === "" ? `${current ?? ""}` : a;
};
const askList = (q: string, current: string[] = []) =>
  ask(`${q} (comma-separated)`, current.join(", ")).split(",").map((s) => s.trim()).filter(Boolean);
const askYes = (q: string, current?: boolean): boolean => {
  const a = ask(`${q} (y/n)`, current === undefined ? undefined : current ? "y" : "n").toLowerCase();
  return /^(y|yes|s|sim)$/.test(a);
};
const askMonth = (q: string, current?: string | null) => {
  const a = ask(`${q} (YYYY-MM, blank if unknown)`, current ?? "");
  return /^\d{4}-\d{2}$/.test(a) ? a : null;
};

console.log(`Onboarding. Every answer stays on this machine: Corpus/ holds your profile
and policy, .env holds identifiers and secrets. Press Enter to keep a value in
[brackets]. Answer truthfully — forms are filled from these answers and nothing
else, and nothing is ever invented to fill a gap.`);

// Identity
section("1. Identity", "Printed on every CV and typed into every form.");
const id = profile.identity ?? {};
id.name = ask("Full legal name", id.name ?? env.APPLICANT_FULL_NAME);
id.email = ask("Email for applications", id.email ?? env.APPLICANT_EMAIL);
id.phone = ask("Phone, international format (+55 11 …)", id.phone ?? env.APPLICANT_PHONE);
id.location = ask("City, state, country", id.location ?? env.APPLICANT_LOCATION);
id.timezone = ask("Time zone", id.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
id.linkedin = ask("LinkedIn URL", id.linkedin ?? env.APPLICANT_LINKEDIN);
id.github = ask("GitHub URL (optional)", id.github ?? env.APPLICANT_GITHUB);
id.website = ask("Website / portfolio (optional)", id.website ?? env.APPLICANT_WEBSITE);
profile.identity = id;

// Work authorization
section("2. Work authorization", `"Will you require sponsorship?" eliminates more applicants than any other
question. It is answered from these facts only — never from where a job is.`);
const el = profile.eligibility ?? {};
el.citizenship = askList("Citizenships (countries)", [el.citizenship ?? []].flat());
el.passports = askList("Passports (nationality adjectives, e.g. Brazilian, Italian)", el.passports ?? []);
el.declare_passport = ask("Which citizenship should forms be told about first", el.declare_passport ?? el.citizenship[0]);
el.country_of_residence = ask("Country you live in", el.country_of_residence);
const EU = /^(austria|belgium|bulgaria|croatia|cyprus|czech|denmark|estonia|finland|france|germany|greece|hungary|ireland|italy|latvia|lithuania|luxembourg|malta|netherlands|poland|portugal|romania|slovakia|slovenia|spain|sweden)/i;
const euCitizen = el.citizenship.some((c: string) => EU.test(c));
el.authorized_to_work = [...new Set([...el.citizenship, ...(euCitizen ? ["European Union", "European Economic Area"] : [])])];
el.requires_sponsorship_for = askList("Where you WOULD need a visa (e.g. US, UK, CA)", el.requires_sponsorship_for ?? ["US", "UK", "CA"]);
el.remote_ready = true;
el.proven_timezones ??= [];
el.overlap_evidence ??= "";
if (euCitizen) {
  el.eu_work_authorization_statement ??= `${el.declare_passport} citizen — full EU work authorization, no sponsorship required`;
}
profile.eligibility = el;

// Languages
section("3. Languages", "Levels are matched to each form's own scale (C1, Advanced, Fluent…).");
const langs = askList("Languages with level, e.g. English:C1, Portuguese:Native, Spanish:Intermediate",
  (profile.languages ?? []).map((l: any) => `${l.language}:${l.level}`));
profile.languages = langs.map((s) => {
  const [language, level] = s.split(":").map((x) => x.trim());
  const prev = (profile.languages ?? []).find((l: any) => l.language === language);
  return { language, level: level ?? "Intermediate", certified: prev?.certified ?? false };
});

// Education
section("4. Education", `Forms ask for the MONTH a degree started and ended. A month you leave blank
keeps those forms waiting for you — it is never guessed.`);
const edu: any[] = [];
for (const e of profile.education ?? []) {
  if (!askYes(`Keep "${e.degree} — ${e.institution}"`, true)) continue;
  if (!e.start_month) e.start_month = Number(ask(`  start month (1-12) of ${e.institution}`, "")) || undefined;
  if (!e.end_month) e.end_month = Number(ask(`  end month (1-12, expected if in progress)`, "")) || undefined;
  edu.push(e);
}
while (askYes(edu.length ? "Add another degree" : "Add a degree or technical course", false)) {
  const institution = ask("  institution");
  const degree = ask("  degree (e.g. BSc Computer Science)");
  const discipline = ask("  discipline as forms list it (e.g. Computer Science)");
  const start = askMonth("  started");
  const end = askMonth("  finished (or expected)");
  const status = askYes("  completed", true) ? "completed" : "in_progress";
  edu.push({
    institution, degree, status,
    start: Number(start?.slice(0, 4)) || null, start_month: Number(start?.slice(5)) || undefined,
    end: Number(end?.slice(0, 4)) || null, end_month: Number(end?.slice(5)) || undefined,
    form: { level: /technic|técnic/i.test(degree) ? "technical_high_school" : "bachelor", discipline: [discipline], school: [institution] },
  });
}
profile.education = edu;

// Employment
section("5. Employment", "Start dates as YYYY-MM: employment blocks on forms ask for the month.");
const jobs: any[] = [];
for (const j of profile.employment ?? []) {
  if (!askYes(`Keep "${j.title_official} — ${j.employer}"`, true)) continue;
  jobs.push(j);
}
while (askYes(jobs.length ? "Add another job" : "Add your current or last job", jobs.length === 0)) {
  const employer = ask("  employer");
  const title = ask("  official title");
  const start = askMonth("  started") ?? "";
  const current = askYes("  still there", jobs.length === 0);
  const end = current ? null : askMonth("  ended");
  jobs.push({ id: employer.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), employer, title_official: title, start, end, current, context: "" });
}
profile.employment = jobs;
profile.declarations = {
  ...(profile.declarations ?? {}),
  worked_at_target_companies: askYes("Have you ever worked at any company you might apply to now", profile.declarations?.worked_at_target_companies ?? false),
};

// Levels
section("6. Your level, by field", `Forms ask "which seniority do you identify with". Many people are senior in
one field and junior in another — answer per field: junior, pleno (mid) or senior.`);
const own = profile.self_assessed_seniority ?? {};
const levels: Record<string, string> = {};
for (const [field, label] of [["it", "IT operations / infrastructure / support"], ["iam", "Identity & access (IAM)"], ["security", "Security (SOC, red team, AppSec…)"], ["fullstack", "Software / full stack"], ["other", "Everything else (DevOps, cloud, data…)"]] as const) {
  levels[field] = ask(`  ${label}`, typeof own === "object" ? own[field] ?? own.other : own);
}
profile.self_assessed_seniority = levels;
const focus: Record<string, string> = {};
console.log("\nWhich levels to TARGET per field: any, up_to_senior or junior (only titles saying junior/entry).");
for (const field of ["it", "iam", "security", "fullstack", "other"]) {
  focus[field] = ask(`  ${field}`, prefs.targeting?.focus_levels?.[field] ?? "any");
}
prefs.targeting = { focus_levels: focus };

// Location
section("7. Where you would work", `Remote roles are judged by who they accept. For hybrid/onsite roles: the cities
where you need no move, and the ones you would move to.`);
prefs.home = {
  country: el.country_of_residence,
  cities: askList("Cities (metro area) where you live and could commute", prefs.home?.cities ?? [id.location?.split(",")[0]].filter(Boolean)),
};
prefs.relocation = { within_country: askList(`Other cities in ${el.country_of_residence} you would move to`, prefs.relocation?.within_country ?? []) };
prefs.answers = {
  ...(prefs.answers ?? {}),
  start_availability: ask("When can you start (as forms should say it)", prefs.answers?.start_availability ?? "In 2 weeks"),
  how_did_you_hear: ask('Default "how did you hear about us" (never referral)', prefs.answers?.how_did_you_hear ?? "LinkedIn"),
  decline_voluntary_demographics: true,
};

// Compensation
section("8. Compensation", `Forms ask your CURRENT pay and your EXPECTATION. Current pay is only typed
where you give it; expectation follows the policy you choose.`);
const cc = profile.current_contract ?? {};
cc.type = ask("Contract type now (employee/CLT, contractor/PJ, freelancer…)", cc.type);
cc.monthly_brl = Number(ask("Current monthly pay, number only (blank = forms that ask stop for you)", cc.monthly_brl ?? "")) || undefined;
cc.benefits = ask("Benefits you receive (or 'none')", cc.benefits ?? "none");
cc.variable_compensation = ask("Variable pay / bonus (or 'none')", cc.variable_compensation ?? "none");
profile.current_contract = cc;
const comp = prefs.compensation ?? {};
comp.prefer_avoidance = !askYes("Always state a number for expected pay (n = say 'negotiable' where allowed)", comp.prefer_avoidance === false);
const capMid = ask("Highest expectation to state for a mid-level role in your home currency, per month (blank = no cap)", comp.caps?.brazil?.mid ?? "");
const capSenior = ask("…and for a senior role (blank = no cap)", comp.caps?.brazil?.senior ?? "");
if (capMid || capSenior) comp.caps = { brazil: { ...(capMid ? { mid: Number(capMid) } : {}), ...(capSenior ? { senior: Number(capSenior), lead: Number(capSenior), principal: Number(capSenior) } : {}) } };
prefs.compensation = comp;

// Self-identification and declarations
section("9. Voluntary questions and declarations", `Demographic questions (gender, race, orientation) are declined unless you say
otherwise here. Declarations are yes/no facts: a fact you skip is never answered.`);
const dis = ask("Disability: 'none', 'yes', or 'decline'", profile.self_identification?.disability ?? "decline");
profile.self_identification = { disability: dis };
profile.declarations = {
  ...profile.declarations,
  veteran: askYes("Are you a protected veteran (US)", profile.declarations?.veteran ?? false),
  held_public_office: askYes("Have you held public or government office", profile.declarations?.held_public_office ?? false),
  relatives_at_target_companies: askYes("Do relatives work at companies you target", profile.declarations?.relatives_at_target_companies ?? false),
};
console.log("Criminal-record questions are never answered by the agent — they always stop for you.");

// Identifiers (.env only)
section("10. Identifiers (optional, stored only in .env)", `Brazilian forms ask a CPF; a few ask a postal address. They are typed where a
form requires them and appear masked in every report.`);
env.APPLICANT_CPF = ask("CPF / national ID (blank to skip)", env.APPLICANT_CPF ?? "");
if (askYes("Add a postal address", Boolean(env.APPLICANT_ADDRESS_STREET))) {
  env.APPLICANT_ADDRESS_STREET = ask("  street and number", env.APPLICANT_ADDRESS_STREET);
  env.APPLICANT_ADDRESS_DISTRICT = ask("  district", env.APPLICANT_ADDRESS_DISTRICT);
  env.APPLICANT_ADDRESS_CITY = ask("  city", env.APPLICANT_ADDRESS_CITY);
  env.APPLICANT_ADDRESS_STATE = ask("  state", env.APPLICANT_ADDRESS_STATE);
  env.APPLICANT_ADDRESS_POSTAL = ask("  postal code", env.APPLICANT_ADDRESS_POSTAL);
  env.APPLICANT_ADDRESS_COUNTRY = ask("  country", env.APPLICANT_ADDRESS_COUNTRY ?? el.country_of_residence);
}

// Mailbox
section("11. Mailbox (optional)", `Some forms email an 8-character code before they accept an application. With
IMAP access the agent reads ONLY those code emails — never prints, stores or
reads anything else. Use an app password, never your real one.`);
const mailboxConsent = askYes("Allow reading security-code emails only", Boolean(env.MAIL_APP_PASSWORD));
if (mailboxConsent) {
  env.MAIL_IMAP_USER = ask("  mailbox address", env.MAIL_IMAP_USER ?? id.email);
  env.MAIL_APP_PASSWORD = ask("  app password (Google: myaccount.google.com/apppasswords)", env.MAIL_APP_PASSWORD ? "(kept)" : "");
  if (env.MAIL_APP_PASSWORD === "(kept)") env.MAIL_APP_PASSWORD = envText.match(/^MAIL_APP_PASSWORD=(.*)$/m)?.[1] ?? "";
}

// Autonomy
section("12. Autonomy", `review: you approve every application before it is sent.
auto: an application that passes every gate is approved automatically.
Either way: one application per company per 24h, no captcha or bot check is
ever bypassed, and those forms come back to you as ready-to-send packs.`);
const autonomy = ask("review or auto", prefs.autonomy?.mode ?? "review") === "auto" ? "auto" : "review";
prefs.autonomy = { mode: autonomy, company_cooldown_hours: 24, daily_cap: Number(ask("Daily cap of sent applications", prefs.autonomy?.daily_cap ?? 20)) || 20 };

// ── Write ──────────────────────────────────────────────────────────────────
mkdirSync(CORPUS_DIR, { recursive: true });
for (const k of ["certifications", "skills", "gaps"]) profile[k] ??= k === "skills" ? { expert: [], proficient: [], intermediate: [], familiar: [] } : [];
await Bun.write(join(CORPUS_DIR, "profile.yaml"), `# Written by bun run onboard — edit freely, then re-run --check.\n${Bun.YAML.stringify(profile, null, 2)}`);
await Bun.write(join(CORPUS_DIR, "preferences.yaml"), `# Written by bun run onboard — edit freely, then re-run --check.\n${Bun.YAML.stringify(prefs, null, 2)}`);

// Shared form answers: the generic set shipped in defaults/, plus the ones
// only this questionnaire can answer.
if (!existsSync(join(CORPUS_DIR, "form-answers.json"))) {
  const generic = (await Bun.file(DEFAULT_ANSWERS).json()) as any[];
  const mine = [
    { q: "When can you start", a: prefs.answers.start_availability, why: "onboarding" },
    ...(cc.monthly_brl ? [
      { q: "current base salary", a: String(cc.monthly_brl), why: "onboarding: current monthly pay" },
      { q: "current salary", a: String(cc.monthly_brl), why: "onboarding: current monthly pay" },
    ] : []),
    { q: "benefits do you currently receive", a: cc.benefits, why: "onboarding" },
    { q: "Do you have variable compensation", a: [/^none$/i.test(cc.variable_compensation) ? "No" : "Yes"], why: "onboarding" },
  ];
  await Bun.write(join(CORPUS_DIR, "form-answers.json"), JSON.stringify([...mine, ...generic], null, 2));
}
if (!existsSync(join(CORPUS_DIR, "claims.yaml"))) {
  await Bun.write(join(CORPUS_DIR, "claims.yaml"), `# Evidence claims — the only material CVs and letters are built from.
# Every claim needs a \`source\` quoting your real CV or a verifiable artifact.
# Ask your agent (the curriculum skill) to extract them from your CV, then
# review every one. See examples/corpus/claims.yaml for the format, and
# test/fixtures/corpus/claims.yaml for a worked set (an invented persona).
claims: []
`);
}

env.APPLICANT_FULL_NAME = id.name; env.APPLICANT_EMAIL = id.email; env.APPLICANT_PHONE = id.phone;
env.APPLICANT_LOCATION = id.location; env.APPLICANT_LINKEDIN = id.linkedin;
env.APPLICANT_GITHUB = id.github; env.APPLICANT_WEBSITE = id.website;
const envPath = join(PROJECT_ROOT, ".env");
await Bun.write(envPath, Object.entries(env).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
chmodSync(envPath, 0o600);

console.log("\nWritten: Corpus/profile.yaml, Corpus/preferences.yaml, Corpus/form-answers.json, .env (mode 600).\n");
const blocking = await report();
if (blocking) {
  console.log("\nFix the items above (the evidence claims usually come last — ask your agent), then run `bun run onboard --check`.");
  process.exit(1);
}
await writeOnboardingRecord({ autonomy, mailboxConsent });
console.log(`\n✓ Onboarding complete${(await onboardingRecord()) ? "" : " (record not written)"}. Next: bun run doctor, then a dry run.`);
