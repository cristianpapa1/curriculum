/**
 * Onboarding — what must be true before the agent may apply on someone's behalf.
 *
 * Every item below is a question a real application form asked, that the
 * pipeline could not answer from a CV, and that it must never guess: which
 * passports, which cities, which months, what salary, what level in which
 * field, what to say about disability. Answered once here, they are applied the
 * same way on every form. Until the record exists, `submit --live` refuses to
 * run; dry runs and document preparation stay available.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { CORPUS_DIR, PROJECT_ROOT } from "../corpus/load.ts";

export interface OnboardingRecord {
  version: 1;
  completedAt: string;
  /** "review": every application approved by the candidate; "auto": gates approve. */
  autonomy: "review" | "auto";
  /** The candidate allowed IMAP access for security codes only. */
  mailboxConsent: boolean;
}

export const RECORD_FILE = join(CORPUS_DIR, ".onboarding.json");

export async function onboardingRecord(): Promise<OnboardingRecord | null> {
  const file = Bun.file(RECORD_FILE);
  if (!(await file.exists())) return null;
  const rec = (await file.json().catch(() => null)) as OnboardingRecord | null;
  return rec?.version === 1 && rec.completedAt ? rec : null;
}

export async function writeOnboardingRecord(rec: Omit<OnboardingRecord, "version" | "completedAt">): Promise<void> {
  await Bun.write(RECORD_FILE, JSON.stringify({ version: 1, completedAt: new Date().toISOString(), ...rec }, null, 2));
}

export interface Gap {
  id: string;
  /** "block": live submission cannot start; "warn": some forms will stop for you. */
  severity: "block" | "warn";
  detail: string;
}

const readYaml = async (file: string): Promise<any> => {
  const f = Bun.file(join(CORPUS_DIR, file));
  return (await f.exists()) ? Bun.YAML.parse(await f.text()) : null;
};

/** Everything the corpus, preferences and .env still lack. Empty = ready. */
export async function onboardingGaps(): Promise<Gap[]> {
  const gaps: Gap[] = [];
  const add = (id: string, severity: Gap["severity"], detail: string) => gaps.push({ id, severity, detail });

  if (CORPUS_DIR.includes(join("fixtures", "corpus"))) {
    add("corpus", "block", "CORPUS_DIR points at the invented test persona, not your corpus");
  }
  const profile = await readYaml("profile.yaml");
  const prefs = (await readYaml("preferences.yaml")) ?? {};
  const claims = await readYaml("claims.yaml");
  if (!profile) {
    add("profile", "block", "Corpus/profile.yaml is missing");
    return gaps;
  }

  const id = profile.identity ?? {};
  for (const k of ["name", "email", "phone", "location"]) if (!id[k]) add(`identity.${k}`, "block", `identity.${k} is empty`);

  const el = profile.eligibility ?? {};
  if (![el.citizenship].flat().filter(Boolean).length) add("citizenship", "block", "no citizenship — sponsorship answers depend on it");
  if (!el.country_of_residence) add("residence", "block", "no country of residence");
  if (!(el.authorized_to_work ?? []).length) add("authorized_to_work", "block", "no work authorization listed");

  if (!(profile.languages ?? []).length) add("languages", "block", "no languages");
  if (!(profile.employment ?? []).length) add("employment", "block", "no employment history");
  for (const e of profile.employment ?? []) {
    if (!/^\d{4}-\d{2}$/.test(String(e.start ?? ""))) add(`employment.${e.id}`, "warn", `${e.employer}: start must be YYYY-MM (forms ask the month)`);
  }
  for (const e of profile.education ?? []) {
    if (!e.start_month || !e.end_month) add(`education.${e.institution}`, "warn", `${e.institution}: months missing — forms that ask will stop`);
  }
  if (!claims?.claims?.length || claims.claims.length < 5) {
    add("claims", "block", "fewer than 5 evidence claims — the documents are built from them (see the skill's corpus step)");
  }

  if (!profile.self_assessed_seniority) add("seniority", "warn", "no self-assessed level — seniority questions will stop");
  if (!profile.declarations) add("declarations", "warn", "no declarations — veteran/public-office/relatives questions will stop");
  if (!profile.self_identification) add("self_identification", "warn", "no self-identification choices — every demographic question is declined");
  if (prefs.compensation?.prefer_avoidance === undefined) add("compensation", "warn", "salary policy not chosen (number or negotiable)");
  if (!prefs.home?.cities?.length) add("home", "warn", "no home cities — place-bound roles are accepted in any city");
  if (!prefs.autonomy?.mode) add("autonomy", "block", "autonomy not chosen (review or auto)");

  const env = await Bun.file(join(PROJECT_ROOT, ".env")).text().catch(() => "");
  for (const k of ["APPLICANT_EMAIL", "APPLICANT_FULL_NAME"]) {
    if (!new RegExp(`^${k}=.+`, "m").test(env)) add(`env.${k}`, "block", `.env: ${k} is not set`);
  }
  if (!existsSync(join(PROJECT_ROOT, ".env"))) add("env", "block", ".env is missing");
  return gaps;
}
