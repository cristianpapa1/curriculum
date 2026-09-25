/**
 * Cover letter renderer.
 *
 * Hand-written cover letters often open by apologising — "my current
 * responsibilities do not reflect my experience", "I currently only work with…".
 * That is a negotiation against yourself in the first sentence a hiring manager
 * reads, and it frames the profile as underemployed before any evidence lands.
 *
 * This renderer leads with the strongest angle-relevant evidence instead, and
 * refuses to emit a letter whose opening negotiates against the candidate
 * (ISC-20). It also requires the company and role to be named (ISC-21) — an
 * unaddressed letter reads as a mass mailing, because it is one.
 */

import type { Corpus } from "../corpus/types.ts";
import { resolveAngle } from "../position/angles.ts";
import { project, requirementBoost, type RequirementEvidence } from "../position/project.ts";
import { escapeHtml, htmlDocument } from "./style.ts";
import { CHROME, LETTER, joinList, type Lang } from "./locale.ts";
import { heldRequiredSkills } from "./cv.ts";
import { relevantCertifications } from "../pipeline/certifications.ts";

/**
 * Certification names are marketing strings: "<Vendor> <Product> 2025 Certified
 * <Thing> Professional". In a letter sentence that reads as noise, so the year
 * and the word "Certified" go, and the vendor platforms that have a universally
 * used abbreviation are abbreviated.
 */
const VENDOR_ABBREVIATIONS: [RegExp, string][] = [
  [/^Amazon Web Services /, "AWS "],
  [/^Google Cloud Platform /, "GCP "],
  [/^Microsoft Azure /, "Azure "],
  [/^Oracle Cloud Infrastructure /, "OCI "],
];

export function shortCertName(name: string): string {
  let short = name.replace(/\b20\d\d\s+/, "").replace(/\bCertified\s+/, "");
  for (const [pattern, abbreviation] of VENDOR_ABBREVIATIONS) short = short.replace(pattern, abbreviation);
  return short.trim();
}

const MISSING_TRANSLATION = "canonical:MISSING-TRANSLATION";

export interface LetterTarget {
  company: string;
  roleTitle: string;
  /** Optional named recipient; falls back to "Hiring Manager". */
  recipient?: string;
  /** Location string from the posting, used for the remote-fit sentence. */
  locationRaw?: string;
  /** Why this company specifically — one clause, operator-supplied. */
  companyHook?: string;
  /** Requested language. Falls back to English if claim coverage is partial. */
  lang?: Lang;
  /** Posting requirements with evidencing claims — picks the letter's evidence. */
  requirements?: RequirementEvidence[];
  /** Required-and-held skill terms, used when `requirements` is absent. */
  requiredSkills?: string[];
  /** EU role that needs no sponsorship: say so in the letter. */
  showWorkAuthorization?: boolean;
  /** Posting title and requirement terms (`postingSignals`): names related certifications, if any. */
  postingSignals?: string;
}

export interface LetterDocument {
  title: string;
  markdown: string;
  html: string;
  claimIds: string[];
  angleId: string | null;
  lang: Lang;
  langFallbackReason: string | null;
}

/**
 * Openings that concede ground. Checked against the FIRST sentence only —
 * acknowledging a genuine gap later in a letter is fine; leading with it is not.
 */
const APOLOGETIC_PATTERNS: RegExp[] = [
  /\bdo(?:es)? not (?:fully |totally |in total )?reflect\b/i,
  /\b(?:although|even though|while|despite)\b/i,
  /\bi (?:may|might) not (?:have|be)\b/i,
  /\bi (?:lack|am lacking|don'?t have|do not have)\b/i,
  /\bi am (?:only|just|merely)\b/i,
  /\bi'?m (?:only|just|merely)\b/i,
  /\bunfortunately\b/i,
  /\bi have (?:limited|little|no) (?:experience|background)\b/i,
  /\bi am currently (?:only )?(?:working (?:as|with|in)|in) (?:it )?support\b/i,
  /\bmy (?:current )?(?:title|role|position) (?:does not|doesn'?t)\b/i,
  /\bi hope\b/i,
  /\bi believe i (?:could|might|may)\b/i,
];

function firstSentence(text: string): string {
  const m = text.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (m?.[0] ?? text).trim();
}

export function findApologeticOpening(text: string): string | null {
  const opening = firstSentence(text);
  for (const re of APOLOGETIC_PATTERNS) {
    const hit = opening.match(re);
    if (hit) return hit[0];
  }
  return null;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function renderLetter(
  corpus: Corpus,
  angleInput: string | null,
  target: LetterTarget,
  options: { claimCount?: number; date?: string } = {},
): LetterDocument {
  if (!target.company?.trim()) throw new Error("letter target requires a company");
  if (!target.roleTitle?.trim()) throw new Error("letter target requires a roleTitle");

  const angle = resolveAngle(angleInput);
  // Draw a wider pool than the three bullets shown, so skipped near-duplicates
  // are replaced rather than leaving the list short.
  const count = options.claimCount ?? 8;
  const claimBoost = requirementBoost(target.requirements);

  // Same whole-document rule as the CV: partial translation falls back entirely.
  const requested: Lang = target.lang ?? "en";
  let lang: Lang = requested;
  let langFallbackReason: string | null = null;

  let projection = project(corpus, angleInput, { limit: count, lang, claimBoost });
  if (requested !== "en") {
    const untranslated = projection.claims.filter((p) => p.variantUsed === MISSING_TRANSLATION);
    if (untranslated.length > 0) {
      lang = "en";
      langFallbackReason =
        `${untranslated.length} of ${projection.claims.length} claims lack a ${requested} ` +
        `translation — letter rendered in English rather than mixed`;
      projection = project(corpus, angleInput, { limit: count, lang: "en", claimBoost });
    }
  }

  const L = LETTER[lang];
  const C = CHROME[lang];
  const claims = projection.claims;
  const id = corpus.profile.identity;
  const recipient = target.recipient?.trim() || C.hiringManager;

  // Claims are written as verb-led fragments ("Built…", "Owns…"). Joined into
  // prose they read as a sentence with its subject missing — the reviewed batch
  // was full of them. As a list after an introducing line they read correctly
  // in all three languages, with no grammar rewriting that could shift meaning.
  // Two claims can describe the same system from different sources (the CV and
  // the GitHub README both describe the internal platform); a letter listing it
  // twice in a row reads as padding, so near-duplicates are skipped.
  const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\d]{4,}/gu) ?? []);
  const similar = (a: string, b: string) => {
    const A = words(a), B = words(b);
    const shared = [...A].filter((w) => B.has(w)).length;
    return shared / Math.max(1, Math.min(A.size, B.size)) > 0.45;
  };
  const evidence: string[] = [];
  for (const c of claims) {
    const text = c.text.replace(/\s+/g, " ").trim().replace(/[.;]$/, "");
    if (evidence.some((e) => similar(e, text))) continue;
    evidence.push(text);
    if (evidence.length >= 3) break;
  }

  // ── Paragraph 1: name the role and company (ISC-21), then the overlap
  // between the posting's stack and the candidate's.
  const stack = heldRequiredSkills(corpus, target.requirements, target.requiredSkills, 5);
  // Certifications only when they relate to the posting; otherwise the letter
  // does not bring them up at all.
  const certs = target.postingSignals === undefined
    ? []
    : relevantCertifications(corpus, target.postingSignals).slice(0, 3).map((c) => shortCertName(c.name));
  const p1 =
    L.opening.replace("{role}", target.roleTitle).replace("{company}", target.company) +
    (stack.length > 0 ? ` ${L.stack(joinList(stack, lang))}` : "") +
    (certs.length > 0 ? ` ${L.certifications(joinList(certs, lang))}` : "");

  // ── Paragraph 3: logistics — remote collaboration, English, work permit.
  const remoteBits: string[] = [];
  const tz = corpus.profile.eligibility.proven_timezones;
  const REGION: Record<Lang, Record<string, string>> = {
    en: {},
    pt: { US: "EUA", India: "Índia" },
    es: { US: "EE. UU." },
  };
  if (tz.length > 0) remoteBits.push(L.timezone(joinList(tz.map((r) => REGION[lang][r] ?? r), lang)));
  const englishLevel = corpus.profile.languages.find((l) => l.language === "English");
  if (englishLevel) remoteBits.push(L.english(englishLevel.level));
  const hook = target.companyHook?.trim();
  const p3 = [
    hook ?? "",
    remoteBits.length > 0 ? `${remoteBits.join(lang === "en" ? ", and " : lang === "pt" ? ", e " : ", y ")}.` : "",
    target.showWorkAuthorization ? corpus.profile.eligibility.work_authorization_letter?.[lang] ?? L.workAuthorization : "",
  ].filter(Boolean).join(" ");

  const p4 = L.closing
    .replace("{company}", target.company)
    .replace("{github}", id.github)
    .replace("{website}", id.website);

  const paragraphs = [p1, p3, p4].filter((p) => p.trim().length > 0);
  const date = options.date ?? todayISO();

  // ── Markdown ───────────────────────────────────────────────────────────
  const md = [
    `${id.name}`,
    `${id.location} · ${id.email} · ${id.phone}`,
    [id.website, id.github, id.linkedin].filter(Boolean).join(" · "),
    ``,
    date,
    ``,
    `${C.salutation} ${recipient},`,
    ``,
    p1,
    ``,
    ...(evidence.length > 0 ? [L.evidenceIntro, ``, ...evidence.map((e) => `- ${e}.`), ``] : []),
    ...[p3, p4].filter(Boolean).flatMap((p) => [p, ""]),
    `${C.signoff}`,
    `${id.name}`,
  ].join("\n");

  // ── HTML ───────────────────────────────────────────────────────────────
  const h: string[] = [];
  h.push(`<h1>${escapeHtml(id.name)}</h1>`);
  h.push(
    `<div class="contact">${escapeHtml(id.location)}<span class="sep">|</span>` +
      `${escapeHtml(id.email)}<span class="sep">|</span>${escapeHtml(id.phone)}` +
      `<span class="sep">|</span>${escapeHtml(id.website)}` +
      (id.linkedin ? `<span class="sep">|</span>${escapeHtml(id.linkedin)}` : "") +
      `</div>`,
  );
  h.push(`<div class="letter">`);
  h.push(`<p class="muted">${escapeHtml(date)}</p>`);
  h.push(`<p class="salutation">${escapeHtml(C.salutation)} ${escapeHtml(recipient)},</p>`);
  h.push(`<p>${escapeHtml(p1)}</p>`);
  if (evidence.length > 0) {
    h.push(`<p>${escapeHtml(L.evidenceIntro)}</p><ul>`);
    for (const e of evidence) h.push(`<li>${escapeHtml(e)}.</li>`);
    h.push(`</ul>`);
  }
  for (const p of [p3, p4].filter(Boolean)) h.push(`<p>${escapeHtml(p)}</p>`);
  h.push(`<p class="signoff">${escapeHtml(C.signoff)}<br>${escapeHtml(id.name)}</p>`);
  h.push(`</div>`);

  // ── Guards ─────────────────────────────────────────────────────────────
  // The denylist is English-keyed, so it only applies to English output. The
  // localized templates are fixed strings, authored non-apologetically by hand.
  const apologetic = lang === "en" ? findApologeticOpening(paragraphs[0] ?? "") : null;
  if (apologetic) {
    throw new Error(
      `cover letter opens apologetically ("${apologetic}") — the first sentence ` +
        `must lead with evidence, never concede ground`,
    );
  }
  const body = paragraphs.join(" ");
  if (!body.includes(target.company) || !body.includes(target.roleTitle)) {
    throw new Error(
      "cover letter must name both the company and the role title (ISC-21)",
    );
  }

  return {
    title: `${id.name} — Cover Letter — ${target.company} — ${target.roleTitle}`,
    markdown: md,
    html: htmlDocument(
      `${id.name} — Cover Letter — ${target.company}`,
      h.join("\n"),
    ),
    claimIds: claims.map((c) => c.claim.id),
    angleId: angle?.id ?? null,
    lang,
    langFallbackReason,
  };
}
