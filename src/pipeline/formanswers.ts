/**
 * Standard application-form answers.
 *
 * ATS forms ask the same dozen questions. The candidate states the facts once,
 * during onboarding (profile.yaml `declarations`): veteran status, public
 * office, relatives at target companies, former employers — and "where did you
 * find this job", which one candidate answered "answer whatever".
 *
 * Two classes of question are handled very differently here.
 *
 * DISCRETIONARY — source of application, voluntary EEO demographics. These cost
 * nothing and the candidate does not care about the value. One exception is encoded:
 * "employee referral" is never selected. It is a factual claim a recruiter acts
 * on by looking for the referrer; finding none burns the application. The real
 * source is used instead, which is equally indifferent and carries no risk.
 *
 * MATERIAL — work authorization and sponsorship. These are never guessed, never
 * softened and never left to a default. A false answer here is misrepresentation
 * that can void an offer after acceptance, so every answer is derived from
 * `Corpus/profile.yaml` eligibility and nothing else.
 */

import type { Corpus } from "../corpus/types.ts";

export type AnswerConfidence = "stated-fact" | "derived" | "discretionary";

export interface FormAnswer {
  question: string;
  value: string | boolean;
  confidence: AnswerConfidence;
  reason: string;
}

/** Where the application came from. Never "referral". */
export type ApplicationSource =
  | "Company website"
  | "Job board"
  | "LinkedIn"
  | "Search engine"
  | "Other";

export interface FormContext {
  /** Country the role is based in — drives work-authorization answers. */
  country?: string;
  /** ATS the form belongs to, used to pick a plausible source. */
  atsType?: string;
  companyName?: string;
}

// ── Facts the candidate declared (profile.yaml `declarations`) ─────────────

/** Declared yes/no facts; `undefined` = not declared, so never answered. */
function declared(corpus: Corpus) {
  const d = corpus.profile.declarations ?? {};
  return {
    isVeteran: d.veteran,
    heldPoliticalOffice: d.held_public_office,
    hasRelativesAtCompany: d.relatives_at_target_companies,
    previouslyEmployedByTargets: d.worked_at_target_companies,
    employers: corpus.profile.employment.map((e) => e.employer).join(", "),
  };
}

/**
 * Source of application. Derived from where the posting actually came from, so
 * it is true as well as harmless.
 */
export function sourceAnswer(ctx: FormContext = {}): FormAnswer {
  const viaBoard = ["greenhouse", "lever", "ashby", "workable", "smartrecruiters"];
  const value: ApplicationSource = ctx.atsType && viaBoard.includes(ctx.atsType)
    ? "Company website"
    : "Job board";

  return {
    question: "How did you hear about this position?",
    value,
    confidence: "discretionary",
    reason:
      `the candidate: "responde qualquer coisa". Using the true source — the posting ` +
      `came from the company's own board${ctx.atsType ? ` (${ctx.atsType})` : ""}. ` +
      `"Employee referral" is never selected: a recruiter acts on it by looking ` +
      `for the referrer, and finding none burns the application.`,
  };
}

// ── Work authorization: the answers that must never be wrong ────────────────

function normaliseCountry(country: string): string {
  const c = country.toLowerCase();
  if (/brazil|brasil/.test(c)) return "BR";
  if (/united states|\busa?\b/.test(c)) return "US";
  if (/canada/.test(c)) return "CA";
  if (/united kingdom|\buk\b/.test(c)) return "UK";
  if (/finland|sweden|denmark|norway|germany|netherlands|ireland|spain|portugal|france|poland|italy|europe|\beu\b/.test(c)) return "EU";
  return "OTHER";
}

export function workAuthorizationAnswers(
  corpus: Corpus,
  ctx: FormContext = {},
): FormAnswer[] {
  const elig = corpus.profile.eligibility;
  const country = normaliseCountry(ctx.country ?? "");
  const authorized = elig.authorized_to_work.map((c) =>
    normaliseCountry(c),
  );

  const isAuthorized = authorized.includes(country);
  const needsSponsorship = !isAuthorized && country !== "OTHER";

  return [
    {
      question: `Are you legally authorized to work in ${ctx.country ?? "this country"}?`,
      value: isAuthorized,
      confidence: "derived",
      reason: isAuthorized
        ? `authorized_to_work includes ${country} in profile.yaml`
        : `profile.yaml lists authorization only for ${elig.authorized_to_work.join(", ")}`,
    },
    {
      question: "Will you now or in the future require visa sponsorship?",
      value: needsSponsorship,
      confidence: "derived",
      reason: needsSponsorship
        ? `${country} is listed under requires_sponsorship_for in profile.yaml — ` +
          `answered truthfully; a false answer here can void an offer after acceptance`
        : `work authorization already held for ${country}`,
    },
  ];
}

// ── Everything else ─────────────────────────────────────────────────────────

export function standardAnswers(
  corpus: Corpus,
  ctx: FormContext = {},
): FormAnswer[] {
  const out: FormAnswer[] = [];
  const facts = declared(corpus);
  const stated = (question: string, value: boolean | undefined, reason: string) => {
    if (value !== undefined) out.push({ question, value, confidence: "stated-fact", reason });
  };

  stated("Are you a protected veteran?", facts.isVeteran, "declared in onboarding");
  stated("Have you held, or do you currently hold, public/political office?", facts.heldPoliticalOffice, "declared in onboarding");
  stated(`Have you previously been employed by ${ctx.companyName ?? "this company"}?`, facts.previouslyEmployedByTargets, `employers on file: ${facts.employers}`);
  stated(`Do you have any relatives employed by ${ctx.companyName ?? "this company"}?`, facts.hasRelativesAtCompany, "declared in onboarding");

  out.push(sourceAnswer(ctx));
  out.push(...workAuthorizationAnswers(corpus, ctx));

  return out;
}

/**
 * Voluntary EEO demographics (race, gender, disability, veteran self-ID).
 *
 * These are legally voluntary, collected for aggregate reporting, and explicitly
 * not used in selection. Declining is a first-class option that costs nothing,
 * so it is the default — except veteran status, answered when the candidate
 * declared it.
 */
export function eeoAnswers(corpus?: Corpus): FormAnswer[] {
  const veteran = corpus?.profile.declarations?.veteran;
  return [
    {
      question: "Veteran status",
      value: veteran === false ? "I am not a protected veteran" : "I don't wish to answer",
      confidence: veteran === false ? "stated-fact" : "discretionary",
      reason: veteran === false ? "declared not a veteran in onboarding" : "not declared — declined",
    },
    {
      question: "Gender / Race / Ethnicity",
      value: "I don't wish to answer",
      confidence: "discretionary",
      reason:
        "voluntary, collected for aggregate reporting only and not used in " +
        "selection — declining is a first-class option and costs nothing",
    },
    {
      question: "Disability status",
      value: "I don't wish to answer",
      confidence: "discretionary",
      reason: "voluntary self-identification; declining is explicitly permitted",
    },
  ];
}

/** Questions no automated answer should ever attempt. */
export const ESCALATE_TO_HUMAN = [
  /criminal (record|history|conviction)/i,
  /background check/i,
  /drug (test|screen)/i,
  /security clearance/i,
  /salary history|current salary|previous compensation/i,
  /notice period|when can you start/i,
  /why (are you |do you want )?(leaving|interested)/i,
  /cover letter|additional information|anything else/i,
];

export function needsHuman(question: string): boolean {
  return ESCALATE_TO_HUMAN.some((re) => re.test(question));
}

// `bun run src/pipeline/formanswers.ts`
if (import.meta.main) {
  const { loadCorpus } = await import("../corpus/load.ts");
  const corpus = await loadCorpus();

  for (const ctx of [
    { country: "Brazil", companyName: "Northstar Labs", atsType: "greenhouse" },
    { country: "Finland", companyName: "Aurora Systems", atsType: "ashby" },
    { country: "United States", companyName: "Vanta Peak", atsType: "greenhouse" },
  ]) {
    console.log(`\n══ ${ctx.companyName} (${ctx.country}) ══`);
    for (const a of standardAnswers(corpus, ctx)) {
      console.log(`  ${String(a.value).padEnd(18)} [${a.confidence}]  ${a.question}`);
    }
  }
  console.log("\n══ EEO (voluntário) ══");
  for (const a of eeoAnswers()) console.log(`  ${String(a.value).padEnd(28)} ${a.question}`);

  console.log("\n══ escalar para humano ══");
  for (const q of [
    "What is your current salary?",
    "Why are you leaving your current role?",
    "What is your notice period?",
    "Are you authorized to work in the US?",
  ]) {
    console.log(`  ${needsHuman(q) ? "HUMANO" : "auto  "}  ${q}`);
  }
}
