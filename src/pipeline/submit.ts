/**
 * Submission bridge — Playwright + Firefox.
 *
 * Why Firefox and not the Interceptor: Interceptor has no file-upload command,
 * and `<input type="file">` cannot be filled from JavaScript. Attaching the CV
 * needs either OS-level input (Interceptor's bridge, macOS only) or a driver
 * that speaks the protocol — which Playwright does via `setInputFiles`.
 *
 * Why this is acceptable despite the earlier objection to Playwright: that
 * objection holds for Workday and LinkedIn, which run aggressive bot detection
 * and soft-fail submissions. Greenhouse, Lever and Ashby application forms do
 * not. The adapters below cover only those.
 *
 * Safety properties, in order of importance:
 *   1. `dryRun` is the DEFAULT. Submitting requires passing `dryRun: false`.
 *   2. Every generated answer passes the anti-fabrication gate before typing.
 *   3. Screenshots are taken before and after, and a submission is only marked
 *      `submitted` once the post-submit screenshot exists on disk.
 *   4. A field the mapper does not understand is REPORTED, never guessed.
 */

import { firefox, type Page, type BrowserContext } from "playwright";
import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { readQuestions, loadAnswerOverrides, applyAnswerOverrides, uniqueMatch } from "./questions.ts";
import { relevantCertifications, certificationsText, signalsForFolder } from "./certifications.ts";
import { ownLevelFor, type OwnLevel } from "./level.ts";
import { inHomeArea } from "./eligibility.ts";
import type { Corpus } from "../corpus/types.ts";
import { PROJECT_ROOT } from "../corpus/load.ts";
import { loadApplications, updateStatus, APPLICATIONS_DIR, type ApplicationMeta } from "../ledger/ledger.ts";
import { loadCredentials } from "./credentials.ts";
import { standardAnswers } from "./formanswers.ts";
import { answerSalary } from "./compensation.ts";
import { generateAnswer, classifyQuestion } from "../render/answers.ts";
import { checkAntiFabrication, formatViolations } from "../position/antifab.ts";
import { waitForSecurityCode, loadMailCredentials } from "./mailcodes.ts";

/** Firefox profile with the logged-in sessions. Survives between runs. */
export const PROFILE_DIR = join(PROJECT_ROOT, ".browser-profile");

/**
 * Firefox locks a profile while it is open, so a dry run cannot share it with a
 * live run in progress. Dry runs use their own profile (no logins are needed
 * to fill a Greenhouse, Lever or Ashby form).
 */
const DRY_RUN_PROFILE_DIR = process.env.DRYRUN_PROFILE_DIR ?? join(PROJECT_ROOT, ".browser-profile-dryrun");

/**
 * Boards never submitted automatically — see the skip in submitApplications.
 *
 * Ashby joined them after accepting eight applications and then answering
 * "flagged as possible spam" to forms filled correctly down to the last radio.
 * Its own remedy is to change network, browser or device, which is evasion of
 * the bot protection
 * rather than a fix, so these go to the candidate as manual packs instead.
 */
export const MANUAL_BOARDS = new Set(["lever", "smartrecruiters", "gupy", "ashby"]);

/**
 * Voluntary self-identification questions. Group membership is never inferred
 * on the candidate's behalf, so these are the one kind of choice group left blank on
 * purpose — and so the only kind an unanswered-radio check must not flag.
 */
const VOLUNTARY_SELF_ID =
  /\b(gender|race|ethnicit|veteran|disabilit|lgbtq|neurodiver|sexual orientation|demographic|self.identif|pronouns?)\b|ra[çc]a|etnia|defici[êe]ncia|g[êe]nero|orienta[çc][ãa]o sexual|pcd\b/i;

export interface SubmitOptions {
  /** DEFAULT TRUE. Fills everything and stops before the submit button. */
  dryRun?: boolean;
  headless?: boolean;
  /** Only submit this application id (`ats:jobId`). */
  only?: string;
  /** Skip these application ids. */
  exclude?: string[];
  /** Only these ATS platforms (adapters whose form filling is verified). */
  ats?: string[];
  limit?: number;
  timeoutMs?: number;
}

export interface FieldReport {
  label: string;
  kind: string;
  action: "filled" | "uploaded" | "selected" | "answered" | "skipped" | "SKIPPED-UNKNOWN" | "BLOCKED" | "MISSING-REQUIRED";
  value?: string;
}

export interface SubmitResult {
  id: string;
  company: string;
  roleTitle: string;
  url: string;
  dryRun: boolean;
  submitted: boolean;
  fields: FieldReport[];
  unknownFields: string[];
  screenshots: string[];
  error?: string;
}

/** Normalize a form label so synonyms collapse. */
const norm = (s: string) => s.toLowerCase().replace(/\*|✱|\(required\)|\s+/g, " ").trim();

interface Filler {
  /** Matches the field's visible label. */
  match: RegExp;
  kind: string;
  /** Returns the value to type, or null to skip. */
  value: (ctx: FillContext) => string | null;
}

interface FillContext {
  corpus: Corpus;
  meta: ApplicationMeta;
  creds: Awaited<ReturnType<typeof loadCredentials>>;
  cvPath: string;
  letterPath: string;
  /** The `__CERTS__` variable: certifications related to this posting, "" if none. */
  certs: string;
  /**
   * Another application to this company was already sent by this pipeline. The
   * candidate may never have applied here personally, and still the second role
   * at that company follows a first one the pipeline sent — which is what the
   * form is asking about.
   */
  appliedBefore: boolean;
  /** The candidate’s own level in this posting’s field (level.ts, from the corpus). */
  ownLevel: OwnLevel;
}

/**
 * Brazilian states are stored and written as the two-letter code the postal
 * service uses ("MG"), while a "State/Province" text field expects the name.
 * Any other value is passed through untouched.
 */
const BR_STATES: Record<string, string> = {
  AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia",
  CE: "Ceará", DF: "Distrito Federal", ES: "Espírito Santo", GO: "Goiás",
  MA: "Maranhão", MT: "Mato Grosso", MS: "Mato Grosso do Sul", MG: "Minas Gerais",
  PA: "Pará", PB: "Paraíba", PR: "Paraná", PE: "Pernambuco", PI: "Piauí",
  RJ: "Rio de Janeiro", RN: "Rio Grande do Norte", RS: "Rio Grande do Sul",
  RO: "Rondônia", RR: "Roraima", SC: "Santa Catarina", SP: "São Paulo",
  SE: "Sergipe", TO: "Tocantins",
};

function spelledOutState(state: string): string {
  return BR_STATES[state.trim().toUpperCase()] ?? state;
}

/**
 * Label → value mapping. Ordered: the first match wins, so put the specific
 * patterns above the general ones (e.g. "country of residence" before "country").
 */
const FILLERS: Filler[] = [
  { match: /^(preferred )?(first name|given name)|^preferred name|^nome$|^primeiro nome|^nombre$/, kind: "text", value: (c) => c.creds.fullName.split(" ")[0]! },
  { match: /^(last name|family name|surname)|^sobrenome|^apellidos?$/, kind: "text", value: (c) => c.creds.fullName.split(" ").slice(1).join(" ") },
  { match: /^(full )?name$|^your name|^nome completo|^nombre completo/, kind: "text", value: (c) => c.creds.fullName },
  { match: /e.?mail|correo/, kind: "email", value: (c) => c.creds.email },
  { match: /phone|telephone|telefone|tel[ée]fono|mobile|celular|contact number|whatsapp number/, kind: "tel", value: (c) => c.creds.phone },
  { match: /^cidade de resid|^ciudad de resid/, kind: "text", value: (c) => c.creds.location },
  { match: /linked.?in/, kind: "url", value: (c) => c.creds.linkedin || c.corpus.profile.identity.linkedin || "" },
  { match: /git.?hub/, kind: "url", value: (c) => c.creds.github },
  { match: /(personal )?(website|portfolio|blog)/, kind: "url", value: (c) => c.corpus.profile.identity.hub ?? c.creds.website },
  // Specific country questions BEFORE any generic "country".
  { match: /country of residence|where do you (currently )?(live|reside)|current country/, kind: "text", value: (c) => c.corpus.profile.eligibility.country_of_residence ?? "Brazil" },
  // "ALL countries where you hold citizenship" is a background-check question:
  // answering only the declared passport would omit Brazil, which is a material
  // omission on a security check. List every citizenship. BEFORE the single-
  // passport filler, which would otherwise match first.
  { match: /(all|every|each) (the )?countr(y|ies).*citizenship|citizenships?\b.*(all|countries)|countries where you hold citizenship/, kind: "text", value: (c) => {
      const cit = c.corpus.profile.eligibility.citizenship;
      const list = Array.isArray(cit) ? cit : [cit];
      const declared = c.corpus.profile.eligibility.declare_passport;
      return [...new Set([declared, ...list].filter(Boolean))].join(", ");
    } },
  { match: /permanent residen/, kind: "text", value: (c) => {
      // A citizen holds the right to permanent residence in each country of citizenship.
      const cit = c.corpus.profile.eligibility.citizenship;
      return (Array.isArray(cit) ? cit : [cit]).join(", ");
    } },
  { match: /passport( country)?|citizenship|nationality/, kind: "text", value: (c) => c.corpus.profile.eligibility.declare_passport ?? c.corpus.profile.eligibility.citizenship[0] ?? null },
  // Postal address, for the forms that require one. Read from .env, masked.
  // Placed before the generic city filler so an address block's own fields win.
  { match: /^(address( line)? ?1|street( address)?|endere[çc]o|logradouro)\b/, kind: "address", value: (c) => c.creds.address.street || null },
  { match: /^(address line ?2|bairro|neighbou?rhood|district)\b/, kind: "address", value: (c) => c.creds.address.district || null },
  { match: /^((postal|zip)( ?code)?|postcode|cep|c[óo]digo postal)\b/, kind: "address", value: (c) => c.creds.address.postal || null },
  // Some forms label it "Province/State" and keep Country as a plain text box.
  // A Brazilian address is stored with the two-letter code the postal service
  // uses, while these fields want the state written out.
  { match: /^(state|province)( ?\/ ?(province|state))?$/, kind: "address", value: (c) => spelledOutState(c.creds.address.state) || null },
  { match: /^(country|pa[íi]s)$/, kind: "address", value: (c) => c.creds.address.country || null },
  { match: /^(city|town|cidade)$/, kind: "address", value: (c) => c.creds.address.city || null },
  { match: /city|location|where are you based/, kind: "text", value: (c) => c.creds.location },
  // Expected pay only. A CURRENT salary is a fact the candidate gives, never an
  // anchor typed in its place ("Informe seu salário atual", Inter).
  { match: /^(?!.*(\bcurrent\b|\batual\b|[úu]ltimo|\bpresent\b|\blast\b)).*(salary|compensation expectation|expected (pay|salary|compensation|total compensation)|pretens[ãa]o salarial|expectativa salarial)/, kind: "text", value: (c) =>
      answerSalary(c.meta.locationRaw, "", { title: c.meta.roleTitle, acceptsText: true, lang: (c.meta.lang as any) ?? "en" }).value },
  { match: /programming language|linguagens? de programa/, kind: "text", value: (c) =>
      [...c.corpus.profile.skills.expert, ...c.corpus.profile.skills.proficient]
        .filter((s) => /^(python|typescript|javascript|bash|powershell|sql)$/i.test(s))
        .join(", ") || "Python, TypeScript, Bash, PowerShell" },
  { match: /referr?er name/, kind: "text", value: () => "" }, // never a referral
  // Some Brazilian forms require the national ID. Reported masked, never logged.
  { match: /^cpf\b/, kind: "cpf", value: (c) => c.creds.cpf || null },
  // "Certifications" as free text: only those related to the posting, and
  // nothing at all when none relate.
  { match: /^(certifications?|licen[cs]es? (and|&) certifications?|certifica[çc][õo]es|certificados?|quais certifica[çc][õo]es)\b/, kind: "text", value: (c) => c.certs || null },
  { match: /^current (or (last|most recent) )?(company|employer)|^(company|employer)$|^empresa atual/, kind: "text", value: (c) =>
      c.corpus.profile.employment.find((e) => e.current)?.employer ?? "" },
];

/**
 * Which document a file input wants, from its id/name (`tag`), the heading of
 * its group and its label. Standard slots name themselves ("resume",
 * "cover_letter"); a custom question's upload (`question_…`) or one that names
 * another document is "other" and gets nothing — a disability-report upload
 * received the CV before this existed.
 */
export function uploadSlot(tag: string, heading: string, label: string): "cv" | "letter" | "other" {
  const CV = /resume|\bcv\b|curr[ií]culo/;
  const LETTER = /cover|letter|carta/;
  const OTHER_DOCUMENT = /laudo|defici|disabilit|medical|m[ée]dic|diploma|transcript|hist[óo]rico escolar|certificad|portfolio|photo|foto|identidade|passport|passaporte|writing sample|work sample/;
  const t = tag.toLowerCase();
  const h = heading.toLowerCase();
  if (LETTER.test(t) || (!CV.test(t) && LETTER.test(`${h} ${label.toLowerCase()}`))) return "letter";
  if (CV.test(t) || CV.test(h)) return "cv";
  if (OTHER_DOCUMENT.test(h) || /^question_/.test(t.trim())) return "other";
  return "cv";
}

/**
 * Free-text questions that are not an invitation to sell experience.
 * Returns undefined when the question IS about experience (generate an answer),
 * a string to use if the field is required, or null to leave it blank.
 */
export function plainTextAnswer(question: string): string | null | undefined {
  const q = question.toLowerCase();
  if (/adjustment|accommodat|accessib|disabilit|reasonable adjust/.test(q)) return "No adjustments needed.";
  if (/pronoun/.test(q)) return null;
  if (/how did you (hear|find|learn)|where did you (hear|find|see)|referr/.test(q)) return "LinkedIn";
  if (/notice period|start date|when can you start|availability to start/.test(q)) return null;
  return undefined;
}

/**
 * The option list belonging to one combobox: the listbox its input controls, or
 * failing that the options currently visible. Never every option on the page —
 * Greenhouse keeps the phone-country list in the DOM beside every question.
 */
async function comboOptions(page: Page, handle: any) {
  const listId = ((await handle.getAttribute("aria-controls").catch(() => null)) ??
    (await handle.getAttribute("aria-owns").catch(() => null)) ?? "") as string;
  return listId
    ? page.locator(`[id="${listId}"] [role=option], [id="${listId}"] [class*=select__option]`)
    : page.locator("[role=option]:visible, [class*=select__option]:visible");
}

async function labelFor(page: Page, handle: any): Promise<string> {
  return (await handle.evaluate((el: any) => {
    const direct =
      el.labels?.[0]?.innerText ||
      el.getAttribute("aria-label") ||
      el.closest("label")?.innerText ||
      "";
    if (String(direct).trim()) return String(direct).replace(/\s+/g, " ").trim();
    // Lever custom questions carry no <label>: the text sits in a sibling
    // `.application-label`, and the only attribute is `cards[uuid][field0]`.
    // Falling back to that name fed a generic pitch into two unlabeled boxes.
    let n = el;
    for (let i = 0; i < 6 && n?.parentElement; i++) {
      n = n.parentElement;
      const q = n.querySelector?.(".application-label, [class*=question-title], [class*=label], legend");
      if (q && !q.contains(el) && String(q.innerText ?? "").trim()) return String(q.innerText).replace(/\s+/g, " ").trim();
    }
    return String(el.placeholder || el.name || "").replace(/\s+/g, " ").trim();
  })) as string;
}

/**
 * What to pick in a combobox, by question.
 *
 * Returns candidate option texts in preference order. Every answer derives from
 * a declared fact or an explicit instruction; a question with no rule returns
 * null and is reported rather than guessed.
 */
export function comboboxPlan(
  question: string,
  ctx: Pick<FillContext, "corpus" | "meta">,
): { terms: string[]; multi: boolean; why: string; fallback?: RegExp } | null {
  const q = question.toLowerCase();
  const elig = ctx.corpus.profile.eligibility;
  const citizenships = Array.isArray(elig.citizenship) ? elig.citizenship : [elig.citizenship];

  // Never referral — the candidate: "answer whatever", minus the one harmful option.
  if (/how did you (hear|find|learn)|where did you (hear|find|see)|source of (your )?application|referral source/.test(q)) {
    return { terms: ["LinkedIn", "Job board", "Company website", "Careers page", "Website", "Other"], multi: false, why: "stated: any source except referral" };
  }

  // Voluntary demographics: decline.
  if (/gender|race|ethnic|hispanic|latino|veteran status|disability|sexual orientation|transgender|pronoun/.test(q)) {
    return {
      terms: ["Decline", "I don't wish", "I do not wish", "Prefer not", "Choose not"],
      multi: false,
      why: "voluntary self-identification — declined",
      // Wording varies per form ("Rather not say", "Not specified"…): read the
      // real options when none of the typed terms surfaces one.
      fallback: /declin|prefer not|rather not|not (to )?(say|disclose|answer|specified)|don.?t wish|do not wish|choose not/i,
    };
  }

  // Acknowledgements that must be accepted to proceed.
  if (/i certify|i acknowledge|i understand|i confirm|i consent|i agree|privacy notice|data (processing|protection)|accurate and complete/.test(q)) {
    return { terms: ["Yes", "I acknowledge", "I agree", "I certify", "I understand", "Acknowledge", "Confirm"], multi: false, why: "required acknowledgement" };
  }

  // Sponsorship before authorization — "authorised to work without sponsorship" must hit this.
  if (/sponsor/.test(q)) {
    const eu = ctx.meta.eligibilityPath === "relocation-europe" || ctx.meta.eligibilityPath === "remote-brazil-eligible";
    const needs = ctx.meta.requiresSponsorship ?? !eu;
    return { terms: [needs ? "Yes" : "No"], multi: false, why: needs ? "sponsorship required for this country" : "EU citizen / remote from Brazil — no sponsorship" };
  }
  if (/legally authori[sz]ed|right to work|eligible to work|authori[sz]ation to work|work permit/.test(q)) {
    const ok = !ctx.meta.requiresSponsorship;
    return { terms: [ok ? "Yes" : "No"], multi: false, why: ok ? `authorized: ${[ctx.corpus.profile.eligibility.citizenship].flat().join(" and ")} citizen` : "would need sponsorship" };
  }

  // Languages spoken fluently: only what the profile declares at fluent level.
  if (/language/.test(q) && /fluen|speak|proficien/.test(q)) {
    const fluent = ctx.corpus.profile.languages
      .filter((l) => /native|c1|c2|fluent/i.test(l.level))
      .map((l) => l.language);
    return { terms: fluent, multi: true, why: "declared native/C1 in profile" };
  }

  // Cities available to work in: the role's own cities.
  if (/cit(y|ies)/.test(q) && /available|work|willing|prefer/.test(q)) {
    const cities = ctx.meta.locationRaw
      .split(/[;|]/)
      .map((s) => s.split(",")[0]!.trim())
      .filter((s) => s && !/remote|hybrid|global/i.test(s));
    return cities.length ? { terms: cities, multi: true, why: "the cities this role is based in" } : null;
  }

  // Citizenship (list every one) before any generic country question.
  if (/citizenship|nationalit/.test(q)) {
    return { terms: [elig.declare_passport ?? citizenships[0]!, ...citizenships], multi: /all|every|select all/.test(q), why: "citizenships on file" };
  }
  if (/country/.test(q)) {
    return { terms: [elig.country_of_residence ?? "Brazil"], multi: false, why: "country of residence" };
  }

  return null;
}

async function fillForm(
  page: Page,
  ctx: FillContext,
  requiredSkills: string[],
): Promise<FieldReport[]> {
  const reports: FieldReport[] = [];
  const all = await page.$$("input, select, textarea");

  // Files FIRST, then wait, then everything else. Ashby's "Autofill from
  // resume" parses an uploaded CV and rewrites form state; anything typed
  // before the upload can be reset internally while the old text stays on
  // screen. That produced "Missing entry for required field: Email" on a form
  // whose email box visibly held the right address.
  const isFile = async (h: any) =>
    ((await h.evaluate((el: any) => el.type || "")) as string) === "file";
  const fileHandles: any[] = [];
  for (const h of all) if (await isFile(h)) fileHandles.push(h);

  // Handles captured before the upload go stale when autofill re-renders the
  // form, so the non-file controls are re-queried after the wait.
  const handles: any[] = [...fileHandles];
  let autofillWaitDone = false;

  for (let idx = 0; idx < handles.length || !autofillWaitDone; idx++) {
    if (idx >= handles.length) {
      if (fileHandles.length > 0) {
        await page.waitForTimeout(5000);
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      }
      autofillWaitDone = true;
      for (const fresh of await page.$$("input, select, textarea")) {
        if (!(await isFile(fresh))) handles.push(fresh);
      }
      if (idx >= handles.length) break;
    }
    const h = handles[idx];
    const type = (await h.evaluate((el: any) => el.type || el.tagName.toLowerCase())) as string;
    if (type === "hidden" || type === "submit" || type === "button") continue;
    const visible = await h.isVisible().catch(() => false);
    if (!visible) continue;
    // react-select renders an aria-hidden twin input only for native "required"
    // validation. It shares the field's label, so the address filler typed
    // a country into the one beside a phone-country "País*" — a value that
    // could pass for an answer while nothing was selected.
    if ((await h.getAttribute("aria-hidden").catch(() => null)) === "true") continue;

    const rawLabel = await labelFor(page, h);
    if (!rawLabel) continue;
    const label = norm(rawLabel);

    // ── file inputs: CV and cover letter ────────────────────────────────
    if (type === "file") {
      // Found live on one Greenhouse form: both upload buttons carry the
      // same generic label, so the cover-letter slot received the CV. The
      // input's own id/name ("resume", "cover_letter") and the heading of its
      // group decide instead.
      //
      // Any OTHER upload is left alone. One Portuguese form carried a second
      // "Anexar" for "Caso você seja uma Pessoa com Deficiência, por favor,
      // anexe o seu laudo" — a medical report — and the CV was attached there
      // too.
      const slot = (await h.evaluate((el: any) => {
        let heading = "";
        let n = el;
        for (let i = 0; i < 5 && n?.parentElement && !heading; i++) {
          n = n.parentElement;
          const first = String(n.innerText ?? "").trim().split("\n")[0]?.trim() ?? "";
          if (first && !/^(attach|anexar|adjuntar|upload|enviar|browse|choose|select|selecionar|or drag|ou arraste|drop)\b/i.test(first)) heading = first;
        }
        return { tag: `${el.id ?? ""} ${el.name ?? ""}`.toLowerCase(), heading: heading.toLowerCase() };
      })) as { tag: string; heading: string };
      const kindOfSlot = uploadSlot(slot.tag, slot.heading, label);
      if (kindOfSlot === "other") {
        reports.push({ label: slot.heading.slice(0, 60) || rawLabel, kind: "file", action: "skipped", value: "not a CV or cover-letter slot — left empty" });
        continue;
      }
      const file = kindOfSlot === "letter" ? ctx.letterPath : ctx.cvPath;
      if (await Bun.file(file).exists()) {
        await h.setInputFiles(file);
        reports.push({ label: rawLabel, kind: "file", action: "uploaded", value: file.split("/").pop() });
      } else {
        reports.push({ label: rawLabel, kind: "file", action: "BLOCKED", value: `missing ${file}` });
      }
      continue;
    }

    // Radios and checkboxes are CHOICES, not text fields. Without this, the
    // "Linkedin" option of a "how did you hear about us" radio group matched
    // the LinkedIn URL filler and was written as if it were a text input.
    if (type === "radio" || type === "checkbox") {
      reports.push({ label: rawLabel, kind: type, action: "SKIPPED-UNKNOWN" });
      continue;
    }

    // Surrounding question text: labels often omit the hint that decides the
    // answer ("Per month, in the currency of the entity…").
    const around = ((await h.evaluate((el: any) => {
      let n = el;
      for (let i = 0; i < 4 && n?.parentElement; i++) n = n.parentElement;
      return (n?.innerText ?? "").slice(0, 400);
    })) as string).toLowerCase();

    // ── salary: numeric fields need a number, and "per month" means monthly ──
    if (/salary|compensation|desired pay|expected pay|pretens[ãa]o/.test(label)) {
      const numericField = type === "number" || /\d/.test((await h.getAttribute("placeholder")) ?? "");
      const monthly = /per month|monthly|\/ ?month|por m[eê]s|mensal/.test(around);
      if (numericField || monthly) {
        const a = answerSalary(ctx.meta.locationRaw, "", { title: ctx.meta.roleTitle, numberRequired: true });
        let n = a.numeric ?? 0;
        if (monthly && a.period === "year") n = Math.round(n / 12 / 50) * 50;
        if (!monthly && a.period === "month") n = n * 12;
        await h.fill(String(n)).catch(() => {});
        reports.push({
          label: rawLabel, kind: "salary", action: "filled",
          value: `${n} ${a.currency}/${monthly ? "month" : "year"} (low anchor, ${a.region})`,
        });
        continue;
      }
    }

    // ── comboboxes (Ashby autocomplete, Greenhouse react-select) ────────────
    // These are not text fields: typing puts a search term in, and only picking
    // an option records an answer. Each question maps to candidates derived
    // from the profile; the first candidate that surfaces an option wins.
    const placeholder = ((await h.getAttribute("placeholder")) ?? "").toLowerCase();
    const isCombobox =
      (await h.getAttribute("role")) === "combobox" ||
      (await h.getAttribute("aria-autocomplete")) !== null ||
      /start typing|^select|search/.test(placeholder);
    if (isCombobox) {
      const question = `${rawLabel} ${around}`.toLowerCase();
      const plan = comboboxPlan(question, ctx);
      if (!plan) {
        reports.push({ label: rawLabel, kind: "combobox", action: "SKIPPED-UNKNOWN" });
        continue;
      }
      const picked: string[] = [];
      for (const term of plan.terms) {
        if (!plan.multi && picked.length > 0) break;
        await h.click({ timeout: 4000 }).catch(() => {});
        await h.fill(term).catch(() => {});
        await page.waitForTimeout(1100);
        // Options of THIS combobox only, and short terms as a leading whole word:
        // an unscoped substring match clicked "Lebanon+961" in the phone-country
        // list for a sponsorship "No" — the phone country code and the answer
        // then disagreed with each other.
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const option = (await comboOptions(page, h))
          .filter({ hasNotText: /referr?al|referred|current employee|friend/i })
          .filter({ hasText: new RegExp(term.length <= 4 ? `^\\s*${escaped}\\b` : escaped, "i") })
          .first();
        if (await option.count()) {
          const text = ((await option.innerText().catch(() => term)) as string).trim();
          await option.click({ timeout: 4000 }).catch(() => {});
          picked.push(text);
        } else {
          await h.fill("").catch(() => {});
        }
      }
      if (picked.length === 0 && plan.fallback) {
        // Open the list without typing and choose from the options that exist.
        await h.fill("").catch(() => {});
        await h.click({ timeout: 4000 }).catch(() => {});
        await h.press("ArrowDown").catch(() => {});
        await page.waitForTimeout(900);
        const option = (await comboOptions(page, h)).filter({ hasText: plan.fallback }).first();
        if (await option.count()) {
          const text = ((await option.innerText().catch(() => "")) as string).trim();
          await option.click({ timeout: 4000 }).catch(() => {});
          if (text) picked.push(text);
        } else {
          await h.press("Escape").catch(() => {});
        }
      }
      reports.push(
        picked.length
          ? { label: rawLabel, kind: "combobox", action: "selected", value: `${picked.join(", ")} — ${plan.why}` }
          : { label: rawLabel, kind: "combobox", action: "SKIPPED-UNKNOWN", value: `no option for: ${plan.terms.join(" / ")}` },
      );
      continue;
    }

    // ── mapped scalar fields ────────────────────────────────────────────
    const filler = FILLERS.find((f) => f.match.test(label));
    if (filler) {
      const v = filler.value(ctx);
      if (v) {
        await h.fill(v).catch(() => {});
        reports.push({ label: rawLabel, kind: filler.kind, action: "filled", value: filler.kind === "cpf" ? "•••••••••••" : filler.kind === "address" ? "(address on file)" : v.slice(0, 60) });
      }
      continue;
    }

    // ── free text: generate, gate, then type ────────────────────────────
    if (type === "textarea") {
      const required =
        (await h.evaluate((el: any) => el.required || el.getAttribute("aria-required") === "true")) ||
        /\*\s*$/.test(rawLabel);

      // A cover-letter box takes the cover letter itself, not a pitch.
      if (/cover letter|carta de apresenta|additional information|anything else you (want|would like) to share/.test(label)) {
        const letter = await Bun.file(ctx.letterPath.replace(/\.pdf$/, ".md")).text().catch(() => "");
        const body = letter.split(/\n\n/).slice(2).join("\n\n").trim(); // drop the address block and date
        if (body) {
          await h.fill(body).catch(() => {});
          reports.push({ label: rawLabel, kind: "textarea/cover-letter", action: "answered", value: body.slice(0, 70) + "…" });
          continue;
        }
      }

      // found live: "let us know if you need any adjustments to the
      // recruitment process" received a sales pitch. Questions that are not
      // about experience are left blank, or answered plainly when required.
      const plain = plainTextAnswer(`${label} ${around}`);
      if (plain !== undefined) {
        if (plain !== null && required) {
          await h.fill(plain).catch(() => {});
          reports.push({ label: rawLabel, kind: "textarea/plain", action: "answered", value: plain });
        } else {
          reports.push({ label: rawLabel, kind: "textarea/plain", action: "skipped", value: "optional, not about experience — left blank" });
        }
        continue;
      }

      // Only questions recognisably about experience, projects or motivation get
      // a generated answer. Found in a dry run: "What was your bachelor's
      // university degree result?" received the same pitch as "Where did you
      // gain your most notable software experience?". Anything else is
      // left for a per-application answers.json and, if required, blocks submit.
      if (classifyQuestion(rawLabel) === "generic") {
        // Not reported as missing here: answers.json is applied later, and the
        // final required-field check decides from what the form then holds.
        reports.push({
          label: rawLabel, kind: "textarea", action: "skipped",
          value: required ? "unrecognised — needs answers.json" : "optional, unrecognised — left blank",
        });
        continue;
      }

      const gen = generateAnswer(ctx.corpus, rawLabel, {
        company: ctx.meta.company,
        roleTitle: ctx.meta.roleTitle,
        angle: ctx.meta.angle,
        requiredSkills,
      });
      const gate = checkAntiFabrication(gen.text, ctx.corpus);
      if (!gate.ok) {
        reports.push({
          label: rawLabel, kind: "textarea", action: "BLOCKED",
          value: `anti-fabrication: ${formatViolations(gate.violations).slice(0, 90)}`,
        });
        continue;
      }
      await h.fill(gen.text).catch(() => {});
      reports.push({ label: rawLabel, kind: `textarea/${gen.kind}`, action: "answered", value: gen.text.slice(0, 70) + "…" });
      continue;
    }

    // ── anything else is reported, never guessed ────────────────────────
    reports.push({ label: rawLabel, kind: type, action: "SKIPPED-UNKNOWN" });
  }

  // Work-authorization radios and selects are answered from derived facts.
  await answerAuthorizationControls(page, ctx, reports);
  await answerSourceControls(page, reports);
  await answerYesNoControls(page, reports, ctx);
  await answerChoiceQuestions(page, ctx, reports);

  await answerLeverLocation(page, ctx, reports);
  await answerAshbyLocation(page, ctx, reports);
  await answerGreenhouseLocation(page, ctx, reports);
  await answerGreenhouseBlocks(page, ctx, reports);

  // Per-application answers written for this form's own questions win over
  // every heuristic above.
  reports.push(...(await applyAnswerOverrides(page, await loadAnswerOverrides(ctx.cvPath, { cpf: ctx.creds.cpf, certs: ctx.certs, appliedBefore: ctx.appliedBefore, ownLevel: ctx.ownLevel, profile: {
    name: ctx.corpus.profile.identity.name,
    employer: ctx.corpus.profile.employment.find((e) => e.current)?.employer,
    title: ctx.corpus.profile.employment.find((e) => e.current)?.title_official,
  } }), (text) => {
    const g = checkAntiFabrication(text, ctx.corpus);
    return g.ok ? null : formatViolations(g.violations);
  })));
  await page.waitForTimeout(500);

  // Record the form as it now stands — questions, options, what is answered —
  // so unanswered company-specific questions can be answered in answers.json.
  const questions = await readQuestions(page);
  await Bun.write(join(dirname(ctx.cvPath), "form-questions.json"), JSON.stringify(questions, null, 2));

  const missing = await findMissingRequired(page);
  // Required radio groups and checkbox groups are invisible to the value-based
  // check (Ashby's U.S.-person declaration was refused after the click).
  //
  // Ashby also marks none of its choice groups required in the DOM, so
  // `q.required` is false for questions its own handler then refuses: one board
  // rejected a U.S.-person declaration and another answered "required field;
  // Missing entry" for an unanswered relocation radio, both after a dry run had
  // reported the form READY. So an unanswered radio or yes/no group counts as
  // missing whether or not the page admits it is required — except the
  // voluntary self-identification questions, which are meant to stay blank.
  for (const q of questions) {
    if (q.answered) continue;
    const choice = q.kind === "radio" || q.kind === "yesno";
    if (!q.required && !(choice && !VOLUNTARY_SELF_ID.test(q.question))) continue;
    if (!["radio", "checkbox", "select", "combobox", "yesno"].includes(q.kind)) continue;
    if (missing.some((m) => m.label.slice(0, 40) === q.question.slice(0, 40))) continue;
    missing.push({ label: q.question.slice(0, 90), kind: q.kind, action: "MISSING-REQUIRED" });
  }
  reports.push(...missing);

  return reports;
}

/**
 * Lever's "Current location" is a geocoding autocomplete: a value typed with
 * fill() finds nothing ("No location found"), and a value not picked from the
 * list leaves the hidden `selectedLocation` empty so the form refuses it. Type
 * the city key by key and pick the suggestion in the candidate's country.
 */
async function answerLeverLocation(page: Page, ctx: FillContext, reports: FieldReport[]): Promise<void> {
  const input = page.locator("input.location-input, input[data-qa=location-input]").first();
  if (!(await input.count()) || !(await input.isVisible().catch(() => false))) return;
  const selected = await page.locator("input[name=selectedLocation]").first().inputValue().catch(() => "");
  if (selected) return;
  const city = (ctx.creds.location || ctx.corpus.profile.identity.location || "").split(",")[0]!.trim();
  const country = /brazil|brasil/i.test(ctx.corpus.profile.eligibility.country_of_residence ?? "Brazil") ? "BRA" : "";
  await input.fill("").catch(() => {});
  await input.pressSequentially(city, { delay: 60 }).catch(() => {});
  await page.waitForTimeout(3000);
  const options = page.locator(".dropdown-location");
  // The geocoder is sometimes slow (Applydigital returned nothing in 3s).
  for (let wait = 0; wait < 3 && (await options.count()) === 0; wait++) await page.waitForTimeout(2500);
  const n = await options.count();
  let pick = -1;
  for (let i = 0; i < n && pick < 0; i++) {
    const t = (await options.nth(i).innerText().catch(() => "")) as string;
    if (t.toLowerCase().startsWith(city.toLowerCase()) && (!country || t.includes(country))) pick = i;
  }
  if (pick < 0) {
    reports.push({ label: "Current location", kind: "location", action: "SKIPPED-UNKNOWN", value: `no suggestion for ${city}` });
    return;
  }
  const label = (await options.nth(pick).innerText()) as string;
  // Lever selects on mousedown, and its invisible hCaptcha overlay intercepts a
  // real pointer click. The hidden selectedLocation is what the form submits.
  await options.nth(pick).dispatchEvent("mousedown").catch(() => {});
  await page.waitForTimeout(800);
  const chosen = await page.locator("input[name=selectedLocation]").first().inputValue().catch(() => "");
  if (!chosen) {
    reports.push({ label: "Current location", kind: "location", action: "SKIPPED-UNKNOWN", value: `suggestion "${label}" did not register` });
    return;
  }
  reports.push({ label: "Current location", kind: "location", action: "selected", value: `${label} — residence` });
}

/**
 * Ashby's required "Location" is a geocoding autocomplete (role=combobox,
 * placeholder "Start typing..."). Left empty, Ashby refuses the form after the
 * click — found live. Type the city and pick the suggestion that names the
 * candidate's own country ("<city>, <state>, <country>").
 */
async function answerAshbyLocation(page: Page, ctx: FillContext, reports: FieldReport[]): Promise<void> {
  const input = page.locator("input.ashby-application-form-input-autocomplete").first();
  if (!(await input.count()) || !(await input.isVisible().catch(() => false))) return;
  const question = ((await input.evaluate((el: any) => {
    let n = el;
    for (let i = 0; i < 6 && n?.parentElement; i++) {
      n = n.parentElement;
      const l = n.querySelector?.("label");
      if (l && !l.contains(el)) return l.innerText;
    }
    return "";
  })) as string).toLowerCase();
  if (!/location|city|where.*based/.test(question)) return;
  // Already chosen: Ashby renders the selection as the input's value.
  if (((await input.inputValue().catch(() => "")) as string).trim()) return;

  const city = (ctx.creds.location || ctx.corpus.profile.identity.location || "").split(",")[0]!.trim();
  const country = ctx.corpus.profile.eligibility.country_of_residence ?? "Brazil";
  await input.click({ timeout: 5000 }).catch(() => {});
  await input.pressSequentially(city, { delay: 50 }).catch(() => {});
  await page.waitForTimeout(2500);
  const listId = (await input.getAttribute("aria-controls").catch(() => null)) ?? "";
  const options = listId ? page.locator(`[id="${listId}"] [role=option]`) : page.locator("[role=option]:visible");
  const n = await options.count();
  let pick = -1;
  for (let i = 0; i < n && pick < 0; i++) {
    const t = ((await options.nth(i).innerText().catch(() => "")) as string).trim();
    if (t.toLowerCase().startsWith(city.toLowerCase() + ",") && t.includes(country)) pick = i;
  }
  if (pick < 0) {
    reports.push({ label: "Location", kind: "location", action: "SKIPPED-UNKNOWN", value: `no suggestion for ${city}, ${country}` });
    return;
  }
  const label = ((await options.nth(pick).innerText()) as string).trim();
  await options.nth(pick).click({ timeout: 5000 }).catch(() => {});
  reports.push({ label: "Location", kind: "location", action: "selected", value: `${label} — residence` });
}

const MONTHS = [
  ["january", "janeiro", "enero"], ["february", "fevereiro", "febrero"], ["march", "março", "marzo"],
  ["april", "abril", "abril"], ["may", "maio", "mayo"], ["june", "junho", "junio"],
  ["july", "julho", "julio"], ["august", "agosto", "agosto"], ["september", "setembro", "septiembre"],
  ["october", "outubro", "octubre"], ["november", "novembro", "noviembre"], ["december", "dezembro", "diciembre"],
];

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/**
 * The value a Greenhouse react-select shows as chosen, or "" when empty. Only
 * the value elements count: the control's whole text includes the placeholder
 * ("Select…", "Selecione…"), which made every empty dropdown read as answered.
 */
async function reactSelectValue(page: Page, id: string): Promise<string> {
  const values = page
    .locator(`[id="${id}"]`)
    .locator("xpath=ancestor::*[contains(@class,'select__control')][1]")
    .locator(".select__single-value, .select__multi-value__label");
  return ((await values.allInnerTexts().catch(() => [])) as string[]).join(", ").trim();
}

/**
 * Open a Greenhouse react-select, optionally type into it, and click the option
 * `choose` returns. Options are read from the field's OWN list — react-select
 * names them after the input id — because the phone-country list is always in
 * the DOM and has been mistaken for other fields' options before.
 */
async function pickReactSelect(
  page: Page,
  id: string,
  search: string | null,
  choose: (options: string[]) => number,
): Promise<string | null> {
  const input = page.locator(`[id="${id}"]`).first();
  if (!(await input.count()) || !(await input.isVisible().catch(() => false))) return null;
  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.click({ timeout: 5000 }).catch(() => {});
  if (search) await input.pressSequentially(search, { delay: 40 }).catch(() => {});
  const options = page.locator(`[id^="react-select-${id}-option"]`);
  for (let wait = 0; wait < 6 && (await options.count()) === 0; wait++) await page.waitForTimeout(700);
  const texts = (await options.allInnerTexts().catch(() => [])).map((t) => t.trim());
  const i = texts.length ? choose(texts) : -1;
  if (i < 0) {
    await input.fill("").catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    return null;
  }
  await options.nth(i).click({ timeout: 5000 }).catch(() => {});
  return texts[i]!;
}

const monthOf = (m: number) => (options: string[]) => options.findIndex((o) => MONTHS[m - 1]!.includes(o.toLowerCase().trim()));

/**
 * Greenhouse's structured Employment and Education blocks, filled by field id.
 *
 * Label matching cannot do this: both blocks label their dates "Start date
 * month" / "Mês da data de início", so an answer meant for the job lands in the
 * degree (found before any form was sent: an education block would have read
 * the employment start date). The ids tell them apart: employment uses
 * `start-date-month-0`, education `start-month--0`.
 *
 * Only facts on file are entered. A month the corpus does not state is left
 * empty, and the form stays blocked until the candidate supplies it.
 */
async function answerGreenhouseBlocks(page: Page, ctx: FillContext, reports: FieldReport[]): Promise<void> {
  // ── Employment: the current job ────────────────────────────────────────
  const job = ctx.corpus.profile.employment.find((e) => e.current);
  if (job && (await page.locator("#company-name-0").count())) {
    for (const [id, value] of [["company-name-0", job.employer], ["title-0", job.title_official]] as const) {
      const field = page.locator(`[id="${id}"]`);
      if ((await field.isVisible().catch(() => false)) && !(await field.inputValue().catch(() => ""))) {
        await field.fill(value).catch(() => {});
        reports.push({ label: id, kind: "employment", action: "filled", value });
      }
    }
    const [year, month] = job.start.split("-").map(Number) as [number, number];
    if (!(await reactSelectValue(page, "start-date-month-0"))) {
      const got = await pickReactSelect(page, "start-date-month-0", null, monthOf(month));
      if (got) reports.push({ label: "start-date-month-0", kind: "employment", action: "selected", value: `${got} — ${job.employer} start` });
    }
    const startYear = page.locator("#start-date-year-0");
    if ((await startYear.isVisible().catch(() => false)) && !(await startYear.inputValue().catch(() => ""))) {
      await startYear.fill(String(year)).catch(() => {});
      reports.push({ label: "start-date-year-0", kind: "employment", action: "filled", value: String(year) });
    }
    const current = page.locator("#current-role-0_1");
    if ((await current.count()) && !(await current.isChecked().catch(() => true))) {
      await current.check({ timeout: 5000 }).catch(() => current.dispatchEvent("click"));
      reports.push({ label: "current-role-0", kind: "employment", action: "selected", value: "current role checked" });
    }
  }

  // ── Education: the completed bachelor's first ──────────────────────────
  const degree =
    ctx.corpus.profile.education.find((e) => e.status === "completed" && e.form?.level === "bachelor") ??
    ctx.corpus.profile.education.find((e) => e.form);
  if (!degree?.form || !(await page.locator("#school--0").count())) return;

  if (!(await reactSelectValue(page, "school--0"))) {
    let got: string | null = null;
    for (const term of degree.form.school) {
      const want = fold(term);
      got = await pickReactSelect(page, "school--0", term, (opts) => {
        // "USP" must BE the acronym ("USP | UNIVERSIDADE…"); longer names must be
        // contained. Among matches the shortest wins, so "FMUSP | FACULDADE DE
        // MEDICINA DA UNIVERSIDADE DE SÃO PAULO" loses to the university itself.
        const hits = opts
          .map((o, i) => ({ i, o: fold(o) }))
          .filter(({ o }) => (want.length <= 4 ? o === want || o.startsWith(`${want} |`) : o.includes(want)))
          .sort((a, b) => a.o.length - b.o.length);
        return hits[0]?.i ?? -1;
      });
      if (got) break;
    }
    reports.push(got
      ? { label: "school--0", kind: "education", action: "selected", value: got }
      : { label: "school--0", kind: "education", action: "SKIPPED-UNKNOWN", value: `no option for ${degree.institution}` });
  }

  if (!(await reactSelectValue(page, "degree--0"))) {
    const completed = degree.status === "completed";
    const wants = degree.form.level === "bachelor"
      ? completed
        ? ["Bachelor's Degree", "Bachelor's", "Bachelor", "Ensino superior completo", "Superior completo", "Graduação completa", "Graduação", "Bacharelado"]
        : ["Bachelor's Degree", "Ensino superior em andamento", "Superior incompleto"]
      : ["Technical Degree", "High School", "Ensino técnico", "Ensino médio completo"];
    const got = await pickReactSelect(page, "degree--0", null, (opts) => {
      for (const w of wants) {
        const i = uniqueMatch(opts, w);
        if (i >= 0) return i;
      }
      return -1;
    });
    reports.push(got
      ? { label: "degree--0", kind: "education", action: "selected", value: got }
      : { label: "degree--0", kind: "education", action: "SKIPPED-UNKNOWN", value: `no option for ${degree.degree}` });
  }

  if (!(await reactSelectValue(page, "discipline--0"))) {
    let got: string | null = null;
    for (const d of degree.form.discipline) {
      got = await pickReactSelect(page, "discipline--0", d, (opts) => uniqueMatch(opts, d));
      if (got) break;
    }
    reports.push(got
      ? { label: "discipline--0", kind: "education", action: "selected", value: got }
      : { label: "discipline--0", kind: "education", action: "SKIPPED-UNKNOWN", value: `no option for ${degree.form.discipline[0]}` });
  }

  for (const [id, month] of [["start-month--0", degree.start_month], ["end-month--0", degree.end_month]] as const) {
    if (!(await page.locator(`[id="${id}"]`).count()) || (await reactSelectValue(page, id))) continue;
    if (!month) {
      reports.push({ label: id, kind: "education", action: "SKIPPED-UNKNOWN", value: `month not on file for ${degree.institution}` });
      continue;
    }
    const got = await pickReactSelect(page, id, null, monthOf(month));
    if (got) reports.push({ label: id, kind: "education", action: "selected", value: got });
  }
  for (const [id, year] of [["start-year--0", degree.start], ["end-year--0", degree.end]] as const) {
    const field = page.locator(`[id="${id}"]`);
    if ((await field.isVisible().catch(() => false)) && !(await field.inputValue().catch(() => ""))) {
      await field.fill(String(year)).catch(() => {});
      reports.push({ label: id, kind: "education", action: "filled", value: String(year) });
    }
  }
}

/**
 * Greenhouse's "Location (City)" is a react-select geocoding autocomplete
 * (`#candidate-location`), not the plain text box the city filler assumes. It
 * was the single most common blocker in an early batch — unanswered on fifteen
 * prepared forms. Type the city and take the suggestion naming the candidate's
 * country.
 */
async function answerGreenhouseLocation(page: Page, ctx: FillContext, reports: FieldReport[]): Promise<void> {
  const input = page.locator("#candidate-location").first();
  if (!(await input.count()) || !(await input.isVisible().catch(() => false))) return;
  // react-select keeps the input itself empty and renders the choice beside it.
  if (await reactSelectValue(page, "candidate-location")) return;

  const city = (ctx.creds.location || ctx.corpus.profile.identity.location || "").split(",")[0]!.trim();
  const country = ctx.corpus.profile.eligibility.country_of_residence ?? "Brazil";
  await input.click({ timeout: 5000 }).catch(() => {});
  await input.pressSequentially(city, { delay: 70 }).catch(() => {});
  await page.waitForTimeout(3000);
  const options = page.locator("[id^='react-select-candidate-location-option']");
  for (let wait = 0; wait < 3 && (await options.count()) === 0; wait++) await page.waitForTimeout(2000);
  const n = await options.count();
  let pick = -1;
  for (let i = 0; i < n && pick < 0; i++) {
    const t = ((await options.nth(i).innerText().catch(() => "")) as string).trim();
    if (t.toLowerCase().startsWith(city.toLowerCase() + ",") && t.includes(country)) pick = i;
  }
  if (pick < 0) {
    reports.push({ label: "Location (City)", kind: "location", action: "SKIPPED-UNKNOWN", value: `no suggestion for ${city}, ${country}` });
    return;
  }
  const label = ((await options.nth(pick).innerText()) as string).trim();
  await options.nth(pick).click({ timeout: 5000 }).catch(() => {});
  reports.push({ label: "Location (City)", kind: "location", action: "selected", value: `${label} — residence` });
}

/**
 * Work authorization and sponsorship appear as radios or selects. These are
 * material statements, so they are answered from the profile, never defaulted.
 */
async function answerAuthorizationControls(
  page: Page,
  ctx: FillContext,
  reports: FieldReport[],
): Promise<void> {
  const country =
    ctx.meta.eligibilityPath === "remote-brazil-eligible"
      ? "Brazil"
      : ctx.meta.locationRaw;
  const answers = standardAnswers(ctx.corpus, {
    country,
    companyName: ctx.meta.company,
    atsType: ctx.meta.atsType,
  });

  for (const a of answers) {
    if (typeof a.value !== "boolean") continue;
    const want = a.value ? /^(yes|sim|true)$/i : /^(no|não|nao|false)$/i;
    const key = /sponsor/i.test(a.question) ? /sponsor/i : /authoriz|authoris|eligible to work/i;

    const groups = await page.$$("fieldset, div[role=radiogroup], .field, div");
    for (const g of groups) {
      const text = ((await g.innerText().catch(() => "")) as string).slice(0, 240);
      if (!key.test(text)) continue;
      const RADIO_SEL = "input[type=radio]";
      const radios = await g.$$(RADIO_SEL);
      for (const r of radios) {
        const lab = await labelFor(page, r);
        if (want.test(lab.trim())) {
          await r.check().catch(() => {});
          reports.push({ label: a.question, kind: "radio", action: "selected", value: lab.trim() });
          break;
        }
      }
      break;
    }
  }
}

/**
 * "How did you hear about us?" radio groups.
 *
 * the candidate said to answer whatever here, with one exception encoded across the
 * system: never "employee referral". A recruiter acts on that by looking for the
 * referrer, finds nobody, and the application burns. A job-board option is
 * equally indifferent and true.
 */
const SOURCE_PREFERENCE = [
  /other online job board/i,
  /job board/i,
  /company (website|site)/i,
  /google/i,
  /search engine/i,
  /other/i,
];
const NEVER_SOURCE = /referr?al|referred|current employee|friend|family/i;

async function answerSourceControls(page: Page, reports: FieldReport[]): Promise<void> {
  const RADIO = "input[type=radio]";
  const radios = await page.$$(RADIO);
  if (radios.length === 0) return;

  const options: { el: any; label: string }[] = [];
  for (const r of radios) {
    if (!(await r.isVisible().catch(() => false))) continue;
    options.push({ el: r, label: (await labelFor(page, r)).trim() });
  }
  // Only treat this as a source question if a referral option exists among them
  // — that is the tell for "how did you hear about us".
  if (!options.some((o) => NEVER_SOURCE.test(o.label))) return;

  for (const pref of SOURCE_PREFERENCE) {
    const hit = options.find((o) => pref.test(o.label) && !NEVER_SOURCE.test(o.label));
    if (!hit) continue;
    await hit.el.check().catch(() => {});
    reports.push({ label: "How did you hear about us?", kind: "radio", action: "selected", value: hit.label });
    return;
  }
}

/**
 * Yes/No questions rendered as button pairs rather than radios.
 *
 * Found by the first dry-run: Ashby renders "Are you over the age of 18?*" as
 * two buttons. It is REQUIRED, it was left blank, and the form would not have
 * submitted. Only questions with an unambiguous factual answer are handled —
 * anything else is left alone and reported.
 */
/**
 * Yes/No answers, DERIVED per application.
 *
 * The first version was a static table, and it produced a false material
 * statement on Drata's form: "Will you require sponsorship to work within the
 * United States?" → "No", because the sponsorship row was written for EU roles.
 * It also answered "criminal record → No" attributed as "stated by the candidate",
 * which the profile never stated. Both are fixed here: authorization and sponsorship come
 * from the application's own eligibility, years-of-experience questions are
 * compared against the real number, and criminal-record questions are not
 * answered at all — they are escalated.
 */
export function yesNoRules(
  meta: ApplicationMeta,
  corpus: Corpus,
  appliedBefore = false,
): { match: RegExp; answer: "Yes" | "No" | null; why: string }[] {
  const needsSponsorship = meta.requiresSponsorship === true;
  const years = (() => {
    const starts = corpus.profile.employment.map((e) => Date.parse(`${e.start}-01`)).filter((n) => !Number.isNaN(n));
    return starts.length ? Math.floor((Date.now() - Math.min(...starts)) / (365.25 * 864e5)) : 0;
  })();
  const residence = (corpus.profile.eligibility.country_of_residence ?? "Brazil").toLowerCase();

  return [
    { match: /over the age of 18|are you 18|at least 18|of legal working age/i, answer: "Yes", why: "adult" },
    {
      // "require <company> to sponsor an immigration case" as well as the usual
      // "require visa sponsorship".
      match: /require (visa )?sponsor|need sponsor|sponsorship to work|require \S+ to sponsor|sponsor an immigration/i,
      answer: needsSponsorship ? "Yes" : "No",
      why: needsSponsorship ? "not authorized in this country — sponsorship genuinely required" : "authorized via Brazilian/EU citizenship",
    },
    {
      match: /legally authori[sz]|legally entitled|right to work|authori[sz]ed to work/i,
      answer: needsSponsorship ? "No" : "Yes",
      why: needsSponsorship ? "not authorized in this country" : "authorized via Brazilian/EU citizenship",
    },
    {
      match: /located in the united states|based in the (us|united states)|currently (live|reside) in the (us|united states)/i,
      answer: residence.includes("united states") ? "Yes" : "No",
      why: `resides in ${corpus.profile.eligibility.country_of_residence ?? "Brazil"}`,
    },
    {
      // Relocation / onsite willingness for place-bound roles the policy accepts.
      match: /willing (and able )?to (commute|relocate)|able to work onsite|available to work (onsite|in (the )?office)|commit to working from one of our offices|able to work from (our|the) office|days (per|a) week in (the|our) office/i,
      answer: meta.eligibilityPath?.startsWith("relocation") || meta.eligibilityPath === "brazil-local" ? "Yes" : null,
      why: "accepts hybrid/onsite in Europe and the US per stated policy",
    },
    { match: /previously (been )?employed (by|at)|worked (here|for us|at .*) before/i, answer: "No", why: "never worked at this company" },
    {
      match: /participated in a (hiring|selection|recruit\w*) process|applied (to|for a (role|position) at|with) \S+ (before|previously|in the (last|past))|previously applied/i,
      answer: appliedBefore ? "Yes" : "No",
      why: appliedBefore ? "the pipeline already sent an application to this company" : "no earlier application to this company",
    },
    { match: /\b(agree|consent|acknowledge)\b.*(polic|terms|processing|contact)/i, answer: "Yes", why: "consent required to submit" },
    // Criminal record: never answered automatically.
    { match: /convicted|criminal (record|history)|background check/i, answer: null, why: "escalated — never answered on the candidate's behalf" },
    {
      // "Do you have 7-10 years…", "5+ years of experience…" — answered against the real number.
      match: /\b(\d{1,2})\s*(\+|-\s*\d{1,2}|or more)?\s*years? of (hands-on |working |professional )?experience/i,
      answer: null, // resolved per question text in answerYesNoControls
      why: `${years} years of professional experience`,
    },
  ];
}

async function answerYesNoControls(
  page: Page,
  reports: FieldReport[],
  ctx: Pick<FillContext, "meta" | "corpus" | "appliedBefore">,
): Promise<void> {
  const YES_NO = yesNoRules(ctx.meta, ctx.corpus, ctx.appliedBefore);
  const years = Number(YES_NO[YES_NO.length - 1]!.why.split(" ")[0]);
  const CONTAINER = "div, fieldset, section, label";
  const CONTROL = "button, [role=radio], [role=button], input[type=radio]";

  for (const q of YES_NO) {
    const containers = await page.$$(CONTAINER);
    let answered = false;

    for (const c of containers) {
      const text = ((await c.innerText().catch(() => "")) as string).trim();
      // Keep the container tight: a huge block matches by accident.
      // Keep the container tight: one question with one Yes/No pair. A length
      // cap alone skipped a 260-character question; a block holding two pairs
      // would answer the wrong one.
      if (!text || text.length > 500 || !q.match.test(text)) continue;
      const pairs = (await c.$$eval("button, [role=radio], input[type=radio]", (els: any[]) =>
        els.filter((e) => /^(yes|no)$/i.test(String(e.innerText || e.value || "").trim())).length).catch(() => 0)) as number;
      if (pairs > 2) continue;

      // Years-of-experience questions: compare against the real number.
      let answer = q.answer;
      let why = q.why;
      const yrs = text.match(/\b(\d{1,2})\s*(\+|-\s*\d{1,2}|or more)?\s*years?/i);
      // Years "as a <title>" is a claim about a title the candidate may never
      // have held; total professional years would overstate it. Escalated.
      if (answer === null && yrs && /experience/i.test(text) && /\bas an? [a-z]/i.test(text)) {
        reports.push({ label: text.split("\n")[0]!.slice(0, 58), kind: "yes/no", action: "SKIPPED-UNKNOWN", value: "years in a named role — escalated, not answered from total years" });
        answered = true;
        break;
      }
      if (answer === null && yrs && /experience/i.test(text)) {
        const minimum = Number(yrs[1]);
        answer = years >= minimum ? "Yes" : "No";
        why = `${years} years of experience vs ${minimum}+ asked — answered truthfully`;
      }
      if (answer === null) {
        // No derivable answer (criminal record, relocation outside policy…).
        reports.push({ label: text.split("\n")[0]!.slice(0, 58), kind: "yes/no", action: "SKIPPED-UNKNOWN", value: why });
        answered = true;
        break;
      }

      const opts = await c.$$(CONTROL);
      for (const o of opts) {
        const inner = ((await o.innerText().catch(() => "")) as string).trim();
        const lab = inner || (await labelFor(page, o));
        if (lab.trim().toLowerCase() !== answer.toLowerCase()) continue;
        await o.click({ timeout: 5000 }).catch(() => {});
        reports.push({
          label: text.split("\n")[0]!.slice(0, 58),
          kind: "yes/no",
          action: "selected",
          value: `${answer} — ${why}`,
        });
        answered = true;
        break;
      }
      if (answered) break;
    }
  }
}

/**
 * Multi-option questions where the right choice is derivable from the profile.
 *
 * Found by a dry run: seven required controls were left blank,
 * including an English-proficiency scale, a relocation question and a consent
 * checkbox. Each is answered from a declared fact, never guessed — the English
 * level comes from `profile.languages`, relocation from whether the candidate already
 * lives where the role is.
 */
async function answerChoiceQuestions(
  page: Page,
  ctx: FillContext,
  reports: FieldReport[],
): Promise<void> {
  const CONTAINER = "div, fieldset, section";
  const CONTROL = "input[type=radio], input[type=checkbox], button, [role=radio]";

  // English level → the option matching the declared certificate.
  const english = ctx.corpus.profile.languages.find((l) => l.language === "English");
  const fluentish = /^(c1|c2|native|fluent|advanced)$/i.test(english?.level ?? "");

  // A role in the candidate's home area needs no relocation.
  const livesHere = inHomeArea(ctx.meta.locationRaw);

  const RULES: { topic: RegExp; pick: RegExp; label: string; why: string }[] = [
    {
      topic: /speak english|understand.*english|fluent|english proficien/i,
      pick: fluentish ? /^i'?m fluent|lead meetings/i : /participate in meetings/i,
      label: "English proficiency",
      why: `declared ${english?.level ?? "?"}${english?.certified ? " certified" : ""}`,
    },
    {
      topic: /relocat/i,
      pick: livesHere ? /don't require relocation/i : /willing to relocate/i,
      label: "Relocation",
      why: livesHere ? "already based where the role is" : "open to relocation",
    },
    {
      topic: /consent.*(sms|text message)/i, pick: /^yes/i,
      label: "SMS consent", why: "keeps the recruiter able to make contact",
    },
    {
      topic: /consent.*whatsapp/i, pick: /^yes/i,
      label: "WhatsApp consent", why: "keeps the recruiter able to make contact",
    },
  ];

  // Group radios by their `name`, which is what actually defines one question.
  // Matching by container text fails here: each radio's computed label returns
  // the whole group's text, so every option matches every pattern and the first
  // one wins regardless of meaning — that is how "I'm fluent" lost to "I can
  // understand work-related emails" on one form.
  const RADIO_ALL = "input[type=radio]";
  const groups = new Map<string, { el: any; label: string }[]>();

  for (const r of await page.$$(RADIO_ALL)) {
    if (!(await r.isVisible().catch(() => false))) continue;
    const name = (await r.evaluate((el: any) => el.name || "")) as string;
    // The option's OWN text, not the group's.
    const own = (await r.evaluate((el: any) => {
      const l = el.closest("label");
      if (l) {
        const clone = l.cloneNode(true) as any;
        clone.querySelectorAll("input").forEach((i: any) => i.remove());
        return clone.textContent ?? "";
      }
      return el.value ?? "";
    })) as string;
    const label = own.replace(/\s+/g, " ").trim();
    if (!label) continue;
    const key = name || label.slice(0, 12);
    groups.set(key, [...(groups.get(key) ?? []), { el: r, label }]);
  }

  for (const [, opts] of groups) {
    if (opts.length < 2) continue;
    const groupText = opts.map((o) => o.label).join(" | ");
    const rule = RULES.find((r) => r.topic.test(groupText));
    if (!rule) continue;
    // Most specific match wins, not the first one encountered.
    const hits = opts.filter((o) => rule.pick.test(o.label));
    const best = hits.sort((a, b) => b.label.length - a.label.length)[0];
    if (!best) continue;
    await best.el.click({ timeout: 5000 }).catch(() => {});
    reports.push({
      label: rule.label, kind: "choice", action: "selected",
      value: `${best.label.slice(0, 46)} — ${rule.why}`,
    });
  }

  // Consent checkboxes ("I agree", "I acknowledge") must be ticked to submit.
  const CHECK = "input[type=checkbox]";
  for (const box of await page.$$(CHECK)) {
    if (!(await box.isVisible().catch(() => false))) continue;
    // The label often sits outside <label>: read the nearest meaningful text.
    const lab = ((await box.evaluate((el: any) => {
      if (el.labels?.[0]?.innerText) return el.labels[0].innerText;
      let n = el;
      for (let i = 0; i < 4 && n?.parentElement; i++) {
        n = n.parentElement;
        if ((n.innerText ?? "").trim().length > 12) return n.innerText;
      }
      return "";
    })) as string).replace(/\s+/g, " ").trim();
    // found live: the box's own label was just "Acknowledge/Confirm",
    // with the data-processing notice in the text around it. A bare
    // acknowledgement label is judged by that surrounding text.
    const bare = /^(acknowledge|confirm|accept|agree|yes)\b[\s/]*(confirm|acknowledge|accept)?\s*\*?$/i.test(lab);
    const context = bare
      ? ((await box.evaluate((el: any) => {
          let n = el;
          for (let i = 0; i < 5 && n?.parentElement; i++) {
            n = n.parentElement;
            if ((n.innerText ?? "").length > 120) return n.innerText;
          }
          return n?.innerText ?? "";
        })) as string).replace(/\s+/g, " ").slice(0, 800)
      : "";
    const text = `${lab} ${context}`;
    const required =
      (await box.evaluate((el: any) => el.required || el.getAttribute("aria-required") === "true")) ||
      /\*\s*$/.test(lab) ||
      (bare && /\*/.test(context.slice(0, 120)));
    const consentToProcess = /\bi (agree|accept|acknowledge|consent)\b|privacy|terms|processing (of )?my|collecting, storing|personal data|your data|data transfer/i.test(text);
    // Never tick marketing opt-ins; those are not a condition of applying.
    const marketing = /newsletter|marketing|promotional|product updates|special offers/i.test(bare ? text : lab);
    if (!consentToProcess || marketing) continue;
    if (!required && !bare && !/^i (agree|accept|acknowledge|consent)/i.test(lab)) continue;
    if (await box.isChecked().catch(() => false)) continue;
    await box.check({ timeout: 5000 }).catch(() => {});
    reports.push({ label: lab.slice(0, 58), kind: "consent", action: "selected", value: "checked" });
  }
}

/**
 * Required questions still unanswered after filling.
 *
 * Reading a screenshot per application does not scale to fifty. This inspects
 * the filled form itself: any visible control whose question is marked required
 * (a trailing `*`, `required`, or `aria-required`) and still has no value is
 * reported, and a live run refuses to click Submit while any remain.
 */
async function findMissingRequired(page: Page): Promise<FieldReport[]> {
  const found = (await page
    .$$eval("input, textarea, select", (els: any[]) => {
      const out: { label: string; kind: string }[] = [];
      const questionFor = (el: any): string => {
        let n = el;
        for (let i = 0; i < 5 && n?.parentElement; i++) {
          n = n.parentElement;
          const lab = n.querySelector?.("label, legend");
          if (lab?.textContent?.trim()) return lab.textContent.trim();
        }
        return el.getAttribute("aria-label") || el.placeholder || el.name || "";
      };
      // Group controls by the question they belong to. A question counts as
      // answered if ANY control in its container carries a value or a rendered
      // selection. Checking each input alone produced false positives on
      // Greenhouse: react-select keeps a hidden, empty, `required` input beside
      // the visible selection, so filled name/email/country read as missing.
      const byQuestion = new Map<string, { answered: boolean; kind: string }>();
      for (const el of els) {
        const style = (globalThis as any).getComputedStyle(el);
        const type = (el.type || el.tagName).toLowerCase();
        if (["hidden", "submit", "button", "radio", "checkbox", "file"].includes(type)) continue;
        // A disabled field is not asked for. Greenhouse's "Current role" box
        // disables the end-date fields but leaves them marked required
        // on more than one board, and they read as unanswered.
        if (el.disabled) continue;
        const q = questionFor(el).replace(/\s+/g, " ").trim();
        if (!q) continue;
        const required = el.required || el.getAttribute("aria-required") === "true" || /\*\s*$/.test(q);
        if (!required) continue;

        const container = el.closest("[class*=select], fieldset, .field, div") ?? el.parentElement;
        const hasSelection = !!container?.querySelector?.(
          "[class*=single-value], [class*=singleValue], [class*=multi-value], [class*=multiValue], [aria-selected=true]",
        );
        const visible = el.offsetParent !== null && style.visibility !== "hidden";
        const hasValue = visible && String(el.value ?? "").trim().length > 0;

        const prev = byQuestion.get(q) ?? { answered: false, kind: type };
        byQuestion.set(q, { answered: prev.answered || hasValue || hasSelection, kind: prev.kind });
      }
      for (const [label, v] of byQuestion) {
        if (!v.answered) out.push({ label: label.slice(0, 90), kind: v.kind });
      }
      return out;
    })
    .catch(() => [])) as { label: string; kind: string }[];

  // Required file inputs with nothing attached. Ashby re-renders its resume
  // input after autofill parses the upload: the file is held and its name is
  // shown, but the new <input> has an empty FileList. The shown filename counts.
  const files = (await page
    .$$eval("input[type=file]", (els: any[]) =>
      els
        .filter((el) => (el.required || el.getAttribute("aria-required") === "true") && !(el.files?.length))
        .filter((el) => {
          let a = el.parentElement;
          for (let i = 0; i < 5 && a; i++, a = a.parentElement) {
            if (a.querySelectorAll("input[type=file]").length > 1) break;
            if (/\.(pdf|docx?|odt|rtf)\b/i.test(a.innerText ?? "")) return false;
          }
          return true;
        })
        .map((el) => el.getAttribute("aria-label") || el.name || el.id || "file"),
    )
    .catch(() => [])) as string[];

  // Required checkboxes left unticked (consent boxes the form will not submit
  // without). A group sharing one name — "How should we communicate with you?
  // Email / Phone / WhatsApp" — is satisfied by any one ticked box.
  const boxes = (await page
    .$$eval("input[type=checkbox]", (els: any[]) => {
      const checkedGroups = new Set(els.filter((el) => el.checked && el.name).map((el) => el.name));
      return els
        .filter((el) => (el.required || el.getAttribute("aria-required") === "true") && !el.checked && el.offsetParent !== null)
        .filter((el) => !(el.name && checkedGroups.has(el.name)))
        .map((el) => (el.labels?.[0]?.innerText || el.parentElement?.innerText || "checkbox").replace(/\s+/g, " ").trim().slice(0, 90));
    })
    .catch(() => [])) as string[];

  return [
    ...found.map((f) => ({ label: f.label, kind: f.kind, action: "MISSING-REQUIRED" as const })),
    ...files.map((f) => ({ label: f, kind: "file", action: "MISSING-REQUIRED" as const })),
    ...boxes.map((b) => ({ label: b, kind: "checkbox", action: "MISSING-REQUIRED" as const })),
  ];
}

/** Text a board shows once it has actually received an application. */
const CONFIRMATION = [
  /application (has been |was )?(successfully )?(submitted|received|sent)/i,
  /thank(s| you) for (applying|your application|your interest)/i,
  /we('ve| have) received your application/i,
  /your application is (in|on its way|complete)/i,
  /successfully applied/i,
  /candidatura (enviada|recebida)|obrigad[oa] por se candidatar/i,
];

/** Text a board shows when it refused the form. */
const VALIDATION = [
  // Captcha verification refused the submission (Lever's invisible hCaptcha).
  // Not retried and never worked around.
  /error verifying your application/i,
  // Anti-spam refusals: nothing was received, and retrying soon makes it worse.
  /flagged as (possible )?spam|couldn.?t submit your application|unusual activity|too many (requests|attempts)/i,
  /this field is required|is required\b|required field/i,
  /please (fill|complete|select|enter|answer|choose)/i,
  /(missing|invalid) (entry|value|field)/i,
  /captcha|verify you are human|recaptcha/i,
  /campo obrigat[óo]rio/i,
];

/** Text a board shows when the posting is gone. */
const CLOSED = [
  /no longer (accepting|available|open)/i,
  /(job|position|posting) (has been |is )?(closed|filled|removed|expired)/i,
  /page (you('re| are) looking for )?(was )?not found|404/i,
  /this job is not available/i,
];

export async function isJobClosed(page: Page): Promise<string | null> {
  const text = ((await page.innerText("body").catch(() => "")) as string).slice(0, 4000);
  for (const re of CLOSED) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}


/** Occurrences of a pattern — a message only counts if the click added one. */
const count = (re: RegExp, s: string) => (s.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) ?? []).length;

/**
 * A step the board inserts between the click and the confirmation (Greenhouse's
 * emailed security code). Called on every poll with the current page text;
 * returns null while it has nothing to do.
 */
export type Interstitial = (
  page: Page,
  text: string,
  baseline: string,
) => Promise<null | { baseline: string } | { error: string }>;

// Page text is read whole. A prompt or message at the BOTTOM of a long posting
// was cut off by an 8,000-character slice — one security-code prompt
// never reached the poll and the application timed out unsent.
/**
 * Poll for up to ~90s after the submit click. Success needs positive evidence
 * (confirmation text, or the form vanishing with a thank-you URL). Anything else
 * — validation errors, a captcha, or simply no change — is NOT a submission.
 */
export async function awaitSubmissionOutcome(
  page: Page,
  beforeText: string,
  opts: { interstitial?: Interstitial; polls?: number; pollMs?: number } = {},
): Promise<{ ok: boolean; evidence: string }> {
  const startUrl = page.url();
  const SUBMIT = "button[type=submit], input[type=submit], button:has-text('Submit')";
  let baseline = beforeText;
  const polls = opts.polls ?? 45;

  for (let i = 0; i < polls; i++) {
    await page.waitForTimeout(opts.pollMs ?? 2000);
    const text = ((await page.innerText("body").catch(() => "")) as string);

    if (opts.interstitial) {
      const step = await opts.interstitial(page, text, baseline);
      if (step && "error" in step) return { ok: false, evidence: step.error };
      if (step && "baseline" in step) {
        // The board asked for something and it was supplied; judge the page
        // against what it showed just before the second submit.
        baseline = step.baseline;
        continue;
      }
    }

    // Two conditions, both required, learned from a live false positive:
    //   1. the confirmation phrase must be NEW — one form carries
    //      "Thanks for your interest" in its application-limits notice before
    //      anything is clicked, and matching it declared three submissions
    //      successful while the request was still in flight;
    //   2. the submit button must be GONE — a real Ashby confirmation replaces
    //      the form, while the false positive showed the button mid-spinner.
    const button = page.locator(SUBMIT).first();
    const submitStillThere = await button.isVisible().catch(() => false);
    for (const re of CONFIRMATION) {
      const m = text.match(re);
      if (!m) continue;
      if (count(re, text) > count(re, baseline) && !submitStillThere) {
        // Let the request settle before the page is closed — closing mid-flight
        // can abort the very submission being confirmed.
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
        return { ok: true, evidence: m[0] };
      }
    }

    const urlChanged = page.url() !== startUrl && /thank|confirm|success|submitted/i.test(page.url());
    if (urlChanged) return { ok: true, evidence: `redirected to ${page.url()}` };

    // Validation messages must also be NEW. Found live on Abinbev's Greenhouse
    // form: "* indicates a required field" sits above every form, matched
    // /required field/ four seconds after the click, and the application was
    // declared refused — and its page closed — while the button still spun.
    const errors = VALIDATION.flatMap((re) => {
      const m = text.match(re);
      return m && count(re, text) > count(re, baseline) ? [m[0]] : [];
    });
    // A disabled or busy button means the request is still in flight.
    const inFlight = submitStillThere && (await button.isDisabled().catch(() => false));
    if (errors.length > 0 && i >= 1 && !inFlight) {
      // Name the unanswered required questions when the form marks them.
      const missing = (await page
        .$$eval("[aria-invalid=true], .error, [class*=error], [class*=invalid]", (els: any[]) =>
          els
            .map((e) => (e.closest("fieldset, div")?.querySelector("label, legend")?.textContent ?? "").trim())
            .filter(Boolean)
            .slice(0, 6),
        )
        .catch(() => [])) as string[];
      return {
        ok: false,
        evidence:
          `form refused: ${[...new Set(errors)].join("; ")}` +
          (missing.length ? ` | unanswered: ${[...new Set(missing)].map((m) => m.slice(0, 50)).join(" · ")}` : ""),
      };
    }
  }
  return { ok: false, evidence: `no new confirmation within ${Math.round((polls * (opts.pollMs ?? 2000)) / 1000)}s — treated as NOT submitted` };
}

/**
 * A visible captcha CHALLENGE ends the attempt. Lever runs an invisible hCaptcha
 * that usually passes a genuine submission silently; when it instead shows a
 * puzzle, that puzzle is for a person. Nothing here tries to solve, skip or
 * work around it — the application is reported as needing the candidate.
 */
export const captchaChallengeGuard: Interstitial = async (page) => {
  const challenged = (await page
    .$$eval("iframe[src*=hcaptcha], iframe[src*=recaptcha], iframe[title*=challenge i]", (frames: any[]) =>
      frames.some((f) => {
        const title = String(f.title ?? "");
        const r = f.getBoundingClientRect();
        // The always-present widget frame is titled "...checkbox for hCaptcha
        // security challenge"; the puzzle is a separate, visible frame.
        return /challenge/i.test(title) && !/checkbox/i.test(title) &&
          r.height > 100 && r.width > 100 && (globalThis as any).getComputedStyle(f).visibility !== "hidden";
      }))
    .catch(() => false)) as boolean;
  return challenged ? { error: "captcha challenge shown — needs a person to solve it (not bypassed); submit by hand" } : null;
};

/** Run several interstitials in order; the first that acts wins the poll. */
export function combineInterstitials(...steps: (Interstitial | null)[]): Interstitial {
  const active = steps.filter((s): s is Interstitial => s !== null);
  return async (page, text, baseline) => {
    for (const step of active) {
      const r = await step(page, text, baseline);
      if (r) return r;
    }
    return null;
  };
}

/**
 * The page asking for the emailed code. Greenhouse localises it: a Portuguese
 * form said "Um código de verificação foi enviado para … digite o código de 8
 * caracteres", and an English-only pattern let the attempt time out
 * unconfirmed. The email itself stays in English.
 */
export const CODE_PROMPT =
  /verification code (was|has been) sent|enter the \d+-character code|security code|c[óo]digo de verifica[çc][ãa]o foi enviado|digite o c[óo]digo de \d+ caracteres|c[óo]digo de seguran[çc]a|c[óo]digo de verificaci[óo]n|introduce el c[óo]digo de \d+ caracteres|c[óo]digo de seguridad/i;
const CODE_INPUT = "input[maxlength='1'], input[autocomplete='one-time-code'], input[name*=security], input[id*=security]";

/**
 * Greenhouse's email gate: after the first click it asks for an 8-character
 * code sent to the applicant's inbox. Runs inside the outcome poll, so the
 * prompt is handled whenever it appears — Abinbev's took longer than the fixed
 * 7.5s window the first version waited. The prompt must be new and come with a
 * code input; the code is read by the IMAP listener, typed, and submit clicked
 * again. Handled once per application.
 */
export function securityCodeInterstitial(meta: Pick<ApplicationMeta, "company">, clickedAt: Date): Interstitial {
  let handled = false;
  return async (page, text, baseline) => {
    if (handled) return null;
    if (count(CODE_PROMPT, text) <= count(CODE_PROMPT, baseline)) return null;
    if ((await page.locator(CODE_INPUT).count()) === 0) return null;
    handled = true;

    if (!(await loadMailCredentials())) {
      return { error: "Greenhouse security code required — email listener not configured (set MAIL_APP_PASSWORD in .env)" };
    }
    let code: string | null;
    try {
      code = await waitForSecurityCode({ since: clickedAt, company: meta.company, timeoutMs: 240_000 });
    } catch (err) {
      return { error: (err as Error).message };
    }
    if (!code) return { error: "security code listener returned nothing" };

    // Greenhouse renders one box per character; fall back to a single field.
    const boxes = page.locator("input[maxlength='1']");
    if ((await boxes.count()) >= code.length) {
      for (let i = 0; i < code.length; i++) await boxes.nth(i).fill(code[i]!).catch(() => {});
    } else {
      await page.locator(CODE_INPUT).first().fill(code).catch(() => {});
    }
    await page.waitForTimeout(800);

    const next = ((await page.innerText("body").catch(() => "")) as string);
    await page
      .locator("button[type=submit], input[type=submit], button:has-text('Submit')")
      .first()
      .click({ timeout: 15_000 })
      .catch(() => {});
    return { baseline: next };
  };
}


export async function submitApplications(
  corpus: Corpus,
  options: SubmitOptions = {},
): Promise<SubmitResult[]> {
  // Default is dry-run. Submitting is opt-in, deliberately.
  const dryRun = options.dryRun !== false;
  const timeout = options.timeoutMs ?? 60_000;

  const creds = await loadCredentials();
  // A LIVE run submits only what the candidate explicitly approved. Filtering on
  // "prepared" let a retry pick up an application from a batch prepared minutes
  // earlier for review — it was refused by the form, so nothing was sent,
  // but that was luck, not design. A dry run may inspect prepared ones freely.
  let apps = (await loadApplications()).filter((a) =>
    dryRun ? a.status === "prepared" || a.status === "approved" : a.status === "approved",
  );
  if (options.only) apps = apps.filter((a) => a.id === options.only);
  if (options.exclude?.length) apps = apps.filter((a) => !options.exclude!.includes(a.id));
  if (options.ats?.length) apps = apps.filter((a) => options.ats!.includes(a.atsType));
  apps.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  if (options.limit) apps = apps.slice(0, options.limit);

  await mkdir((dryRun ? DRY_RUN_PROFILE_DIR : PROFILE_DIR), { recursive: true });
  const context: BrowserContext = await firefox.launchPersistentContext((dryRun ? DRY_RUN_PROFILE_DIR : PROFILE_DIR), {
    headless: options.headless ?? true,
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
  });

  const results: SubmitResult[] = [];
  // Reloaded after every live attempt: a snapshot taken once would not see a
  // submission made earlier in this same run, and the cooldown would wave a
  // second role at the same company through minutes later.
  let ledgerNow = await loadApplications();
  let spamStop = false;

  try {
    for (const meta of apps) {
      const folder = await folderOf(meta);
      const result: SubmitResult = {
        id: meta.id, company: meta.company, roleTitle: meta.roleTitle, url: meta.url,
        dryRun, submitted: false, fields: [], unknownFields: [], screenshots: [],
      };

      if (!dryRun) {
        // Boards behind captcha or bot protection are submitted by hand from
        // MANUAL-SUBMIT.md: Lever's invisible hCaptcha rejected an automated
        // submission, and SmartRecruiters' apply app sits behind DataDome.
        if (MANUAL_BOARDS.has(meta.atsType)) {
          result.error = `skipped —  is submitted by hand (captcha / bot protection): see MANUAL-SUBMIT.md`;
          results.push(result);
          continue;
        }
        if (spamStop) {
          result.error = "skipped — an earlier submission in this run was flagged as spam; live run halted";
          results.push(result);
          continue;
        }
        // Same company within 24h: anti-spam systems key on exactly this.
        const cooling = companyCooldown(meta, ledgerNow);
        if (cooling) {
          result.error = `skipped — ${cooling}`;
          results.push(result);
          continue;
        }
      }

      const page = await context.newPage();
      try {
        // Go to the form itself, not the careers page around it. Companies such
        // some companies host Greenhouse inside an iframe on their own site, where
        // the fields are invisible to the main frame and nothing gets filled.
        await page.goto(applyUrlFor(meta), { waitUntil: "domcontentloaded", timeout });
        await page.waitForTimeout(3000);

        // Postings close between preparation and submission.
        const closed = await isJobClosed(page);
        if (closed) {
          await updateStatus(meta.id, {
            status: "withdrawn",
            notes: [...(meta.notes ?? []), `${new Date().toISOString().slice(0, 10)} posting closed: "${closed}"`],
          });
          result.error = `posting closed — "${closed}"`;
          results.push(result);
          await page.close().catch(() => {});
          continue;
        }

        // Ashby and some Greenhouse boards hide the form behind an Apply button.
        const apply = page.locator("button:has-text('Apply'), a:has-text('Apply Now'), a:has-text('Apply for this job')").first();
        if (await apply.count()) {
          await apply.click({ timeout: 10_000 }).catch(() => {});
          await page.waitForTimeout(2500);
        }

        const report = await Bun.file(join(folder, "match-report.json")).json().catch(() => ({ matches: [] }));
        const requiredSkills: string[] = (report.matches ?? [])
          .filter((m: any) => m.matched)
          .map((m: any) => m.term);

        result.fields = await fillForm(
          page,
          {
            corpus, meta, creds,
            cvPath: join(folder, meta.cvFile),
            letterPath: join(folder, meta.letterFile),
            certs: certificationsText(relevantCertifications(corpus, await signalsForFolder(folder, meta.roleTitle))),
            ownLevel: ownLevelFor(meta.roleTitle),
            appliedBefore: ledgerNow.some((o) => o.id !== meta.id && o.company.toLowerCase() === meta.company.toLowerCase() && Boolean(o.submittedAt)),
          },
          requiredSkills,
        );
        const touched = result.fields.filter((f) =>
          ["filled", "uploaded", "selected", "answered"].includes(f.action),
        ).length;
        if (touched === 0) {
          // An empty result must never read as "filled". It means the form was
          // not reachable (iframe, login wall, unsupported page).
          throw new Error("no form fields found or filled — page unsupported, nothing to submit");
        }

        result.unknownFields = result.fields
          .filter((f) => f.action === "SKIPPED-UNKNOWN")
          .map((f) => f.label);

        // Capture the FORM, not the page. Greenhouse renders the whole job
        // description above the form, producing an 8,000px image in which the
        // filled fields are unreadable — useless for reviewing fifty of them.
        const shot = join(folder, dryRun ? "dry-run-filled.png" : "pre-submit-filled.png");
        const form = page.locator("form").filter({ has: page.locator("input[type=file], textarea, input[type=email]") }).last();
        if (await form.count()) {
          await form.screenshot({ path: shot }).catch(async () => {
            await page.screenshot({ path: shot, fullPage: true });
          });
        } else {
          await page.screenshot({ path: shot, fullPage: true });
        }
        result.screenshots.push(shot);

        if (!dryRun) {
          const blocked = result.fields.some((f) => f.action === "BLOCKED");
          const missing = result.fields.filter((f) => f.action === "MISSING-REQUIRED");
          if (blocked || missing.length > 0) {
            result.error = blocked
              ? "a field was blocked (anti-fabrication or missing file) — not submitted"
              : `${missing.length} required field(s) unanswered — not submitted: ${missing.map((m) => m.label.slice(0, 40)).join(" · ")}`;
          } else {
            const btn = page.locator("button[type=submit], input[type=submit], button:has-text('Submit')").first();
            // Snapshot the page text BEFORE clicking, so confirmation must be new.
            const beforeText = ((await page.innerText("body").catch(() => "")) as string);
            const clickedAt = new Date();
            // Lever's invisible hCaptcha overlay can intercept a pointer click; the
            // form's own submit handler (which runs the captcha check) still fires
            // on a dispatched click. A visible challenge is never solved here.
            await btn.click({ timeout: 8_000 }).catch(async () => { await btn.dispatchEvent("click"); });

            // A click is not a submission. Wait for the page to SAY it received
            // the application; if instead it shows validation errors, nothing
            // was sent and the record must stay `prepared`. Marking it submitted
            // on the click alone is the silent failure this system exists to avoid.
            // Greenhouse holds the application behind an emailed security code,
            // handled inside the same wait whenever its prompt appears.
            const outcome = await awaitSubmissionOutcome(page, beforeText, {
              interstitial: combineInterstitials(
                captchaChallengeGuard,
                meta.atsType === "greenhouse" ? securityCodeInterstitial(meta, clickedAt) : null,
              ),
            });
            const proof = join(folder, outcome.ok ? "submission-proof.png" : "submit-attempt.png");
            await page.screenshot({ path: proof, fullPage: true });
            result.screenshots.push(proof);

            if (outcome.ok) {
              await updateStatus(meta.id, {
                status: "submitted",
                submittedAt: new Date().toISOString(),
                proofFile: "submission-proof.png",
                notes: [...(meta.notes ?? []), `confirmed: "${outcome.evidence}"`],
              });
              result.submitted = true;
            } else {
              await updateStatus(meta.id, {
                notes: [
                  ...(meta.notes ?? []),
                  `${new Date().toISOString().slice(0, 16)} submit NOT confirmed — ${outcome.evidence}`,
                ],
              });
              result.error = `not submitted — ${outcome.evidence}`;
              // Ashby shows "We couldn't submit your application" above the spam
              // explanation; the evidence carries only the first matching phrase,
              // so the halt must key on that phrase too: one more application
              // went out after the first flag because it did not.
              if (/spam|unusual activity|too many|couldn.?t submit your application/i.test(outcome.evidence)) spamStop = true;
            }
          }
        }
      } catch (err) {
        result.error = (err as Error).message.split("\n")[0];
      } finally {
        await page.close().catch(() => {});
      }

      results.push(result);
      if (!dryRun) ledgerNow = await loadApplications();

      // Space live submissions out: a burst of identical-shaped applications
      // seconds apart is exactly what anti-abuse heuristics look for.
      if (!dryRun && apps.indexOf(meta) < apps.length - 1) {
        await new Promise((r) => setTimeout(r, 25_000 + Math.floor(Math.random() * 20_000)));
      }
    }
  } finally {
    await context.close();
  }

  return results;
}

async function folderOf(meta: ApplicationMeta): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(APPLICATIONS_DIR)) {
    const f = Bun.file(join(APPLICATIONS_DIR, entry, "meta.json"));
    if (!(await f.exists())) continue;
    try {
      if (((await f.json()) as ApplicationMeta).id === meta.id) return join(APPLICATIONS_DIR, entry);
    } catch { /* skip */ }
  }
  throw new Error(`no folder on disk for ${meta.id}`);
}

/**
 * The URL that renders the application FORM directly.
 *
 * Greenhouse's embed endpoint takes the job id alone and serves the bare form —
 * no job description, no company-site wrapper, no iframe. Other boards already
 * link to a page that contains the form.
 */
export function applyUrlFor(meta: ApplicationMeta): string {
  if (meta.atsType === "greenhouse" && meta.jobId) {
    return `https://boards.greenhouse.io/embed/job_app?token=${encodeURIComponent(meta.jobId)}`;
  }
  if (meta.atsType === "ashby" && !/\/application\b/.test(meta.url)) {
    return `${meta.url.replace(/\/+$/, "")}/application`;
  }
  return meta.url;
}

/**
 * Whether another application to the same company was attempted in the last
 * 24 hours — submitted, or refused after a click. Returns the reason, or null.
 *
 * Found live: a second attempt on ICEYE minutes after a successful one was
 * flagged "as possible spam". Every Ashby company shares that infrastructure,
 * so repeated attempts risk flagging the applicant everywhere, not just there.
 */
/**
 * An attempt the form itself rejected over a field — the server stored nothing,
 * so it is not an application and must not spend the company's 24h slot. One
 * board answered "required field; Missing entry" to an unanswered radio, and the
 * cooldown then locked out the corrected resubmit for a day, which is
 * also the one retry a human would make within the minute. Refusals that are
 * ambiguous ("no new confirmation") or about rate limiting still count.
 */
const FIELD_REFUSAL =
  /submit NOT confirmed — form refused:(?!.*(spam|unusual activity|too many|couldn.?t submit your application)).*\b(required|missing|invalid|incomplete|complete this|fill (in|out))\b/i;

export function companyCooldown(
  meta: Pick<ApplicationMeta, "id" | "company">,
  ledger: Pick<ApplicationMeta, "id" | "company" | "submittedAt" | "notes">[],
  now = Date.now(),
): string | null {
  const DAY = 24 * 3600 * 1000;
  for (const other of ledger) {
    if (other.company.toLowerCase() !== meta.company.toLowerCase()) continue;
    const attempts = [
      other.submittedAt,
      ...(other.notes ?? [])
        .filter((n) => !FIELD_REFUSAL.test(n))
        .map((n) => n.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\s+submit NOT confirmed/)?.[1])
        .map((t) => (t ? `${t}:00Z` : null)),
    ].filter(Boolean) as string[];
    for (const at of attempts) {
      const ts = Date.parse(at);
      if (!Number.isNaN(ts) && now - ts < DAY) {
        return `${meta.company} was attempted ${Math.round((now - ts) / 3600000)}h ago (${other.id === meta.id ? "this role" : "another role"}) — 24h cooldown`;
      }
    }
  }
  return null;
}
