/**
 * Fit gate — the checks a recruiter makes in the first ten seconds.
 *
 * The scorer measures technical coverage. A batch of fifty prepared applications
 * showed what coverage alone lets through, all scoring 70–81:
 *
 *   - LEVEL:    "Head of International Security", "Engineering Manager",
 *               "Telco Field Engineering Director", "Staff Engineer",
 *               "Engineering Site Lead", and a "Staff Security Engineer" whose
 *               screener asked for fifteen years.
 *   - TITLE TECH: "Senior Software Engineer - C Programmer",
 *               "Intermediate Java Developer" — languages the corpus lacks.
 *               Single-letter "C" never surfaced as a gap at all.
 *   - LANGUAGE: "Architecte Cloud Azure F/H", "Ingénieur SRE AWS F/H" —
 *               postings written in French, so French is the working language.
 *
 * Each of these is a near-certain rejection, and sending them costs more than
 * the slot: it teaches the ledger nothing true about which positioning works.
 */

import type { Corpus } from "../corpus/types.ts";
import type { NormalizedJob } from "../ats/types.ts";

export interface FitVerdict {
  ok: boolean;
  reason: string;
  check: "level" | "title-tech" | "posting-language" | "citizenship" | "reserved-audience" | "pass";
}

/**
 * Requirements no answer can satisfy without citizenship or a clearance the
 * candidate does not hold: defence and government postings rank high on a
 * technical score and no truthful application to them can succeed.
 */
const CITIZENSHIP_REQUIRED =
  /\b(must be a|requires?|required to be a|only) (u\.?s\.?|united states) citizen|\bu\.?s\.? citizenship (is )?required|\bus persons? (status )?(is )?required|\bactive (secret|top secret|ts\/sci) clearance|\b(secret|top secret|ts\/sci) (security )?clearance (is )?required|\b(obtain|maintain|eligible for) (a |an )?(u\.?s\.? )?(government |federal )?security clearance|\bitar\b/i;

/**
 * Postings reserved for a specific group. Includes DoD SkillBridge, which is
 * open only to transitioning US service members: those postings score well on
 * requirements and are closed to anyone outside the programme.
 */
const RESERVED_AUDIENCE =
  /exclusiv[ao]s? para (pessoas com defici[êe]ncia|pcds?|pessoas negras|pessoas pretas|mulheres|pessoas trans|pessoas lgbt\w*|pessoas 50\+)|\bvaga (afirmativa|exclusiva)\b|\b(women|female) (applicants )?only\b|\bonly (women|female) applicants\b|\bexclusiv[ao]s? para pessoas\b|\bskillbridge\b|\btransitioning (military |service ?)members?\b|\bveterans? only\b/i;

/**
 * Engineering disciplines outside software, infrastructure and security.
 *
 * The Portuguese half matters as much as the English: a Brazilian-board sweep
 * for "infraestrutura" returns "Técnico de Infraestrutura ELÉTRICA Jr." and
 * "Analista Energia e Infraestrutura Jr", where the shared word is the
 * building's wiring, not a network.
 */
const OUT_OF_DOMAIN =
  /\b(electrical|mechanical|hardware|civil|chemical|aerospace|manufacturing|propulsion|avionics|rf|firmware|embedded|structural)( design)? (engineer|engineering|technician)\b|\bflight test\b|\bprocess engineer\b|\b(el[ée]trica|el[ée]trico|mec[âa]nica|mec[âa]nico|hidr[áa]ulica|civil|qu[íi]mica|predial|automotiva|energia)\b(?![^,]*\b(ti|t\.i\.|sistemas|software|dados|rede)\b)/i;

/** Business functions, whatever department they sit in. */
const BUSINESS_FUNCTION =
  /\b(financeir[oa]|finance analyst|de neg[óo]cios|business analyst|comercial|vendas|sales|compras|procurement|marketing|recursos humanos|cont[áa]bil|jur[íi]dic[oa])\b/i;

// ── 1. Level ceiling ───────────────────────────────────────────────────────
// Titles above an individual-contributor senior: Staff, Principal and the
// management tracks. They score well on requirements and are near-certain
// rejections without the years and the people-management history they assume.
// "Member of Technical Staff" is a flat title at several AI labs and is NOT a
// level signal.
const ABOVE_LEVEL = [
  /\bhead of\b/i, /\bdirector\b/i, /\bvice president\b|\bvp\b/i, /\bchief\b/i,
  /\bprincipal\b/i, /\bdistinguished\b/i, /\bfellow\b/i,
  /\bengineering manager\b/i, /\bmanager,/i, /\bmanager\b(?!.*\bproduct\b)/i,
  /\bsite lead\b/i, /\bteam lead\b/i, /\bhead\b/i,
  // "Lead Software Engineer (Cloud Network)" sits above senior.
  /^lead\b/i, /\btech lead(er)?\b/i,
  // "Engineering Lead, Payments Platform" passed every pattern above: the word
  // before "lead" decides, so name the discipline forms and the "Lead <role>"
  // shape wherever it appears in the title.
  /\b(engineering|technical|technology|platform|infrastructure|security|data|delivery|practice|squad|group)\s+lead(er)?\b/i,
  /\blead\s+(software|security|platform|data|cloud|systems?)?\s*(engineer|developer|architect|analyst|scientist)\b/i,
  // Portuguese and Spanish management titles: an IAM sweep on a Brazilian board
  // returns "Gerente de Gestão de Identidades" and "Tech Leader de Governança".
  /\bgerente\b/i, /\bcoordenador(a)?\b/i, /\bcoordinador(a)?\b/i, /\bsupervisor(a)?\b/i,
  /\bdiretor(a)?\b/i, /\bdirector(a)?\b/i, /\bl[íi]der\b/i, /\bjefe\b/i, /\bsuperintendente\b/i,
];
const STAFF = /\bstaff\b/i;
const FLAT_STAFF_TITLE = /member of technical staff/i;

// ── 2. Technologies named in the title ─────────────────────────────────────
// A title that names a language is a hard requirement. Only languages and
// runtimes are policed — a title naming "Azure" or "AWS" is handled by scoring.
const TITLE_TECH: { name: string; re: RegExp }[] = [
  { name: "C", re: /\bC\s*([Pp]rogrammer|[Dd]eveloper|[Ee]ngineer)|\(C\)|\bin C\b|\bC\/C\+\+/ },
  { name: "C++", re: /C\+\+/ },
  { name: "C#", re: /C#|\.NET\b/i },
  { name: "Java", re: /\bJava\b(?!Script)/i },
  { name: "Go", re: /\bGo(lang)?\b(?= (developer|engineer|backend))|\bGolang\b/i },
  { name: "Rust", re: /\bRust\b/i },
  { name: "Scala", re: /\bScala\b/i },
  { name: "Kotlin", re: /\bKotlin\b/i },
  { name: "Swift", re: /\bSwift\b|\biOS\b/i },
  { name: "Ruby", re: /\bRuby\b|\bRails\b/i },
  { name: "PHP", re: /\bPHP\b/i },
  { name: "Elixir", re: /\bElixir\b/i },
  { name: "Android", re: /\bAndroid\b/i },
  { name: "Kubernetes", re: /\bKubernetes\b|\bK8s\b/i },
  { name: "DB2", re: /\bDB2\b/i },
];

// ── 3. The language the posting is written in ─────────────────────────────
// Stopword frequency is crude but decisive: a job description that is mostly
// French is a French-speaking job, whatever the location field says.
const STOPWORDS: Record<string, RegExp> = {
  en: /\b(the|and|with|for|you|our|will|are|of)\b/gi,
  fr: /\b(le|la|les|et|des|pour|avec|vous|nous|une|est|dans)\b/gi,
  de: /\b(und|der|die|das|mit|für|wir|sie|ist|ein|eine|zu)\b/gi,
  es: /\b(el|los|las|para|con|una|que|del|por|nuestro|somos)\b/gi,
  pt: /\b(o|os|as|para|com|uma|que|do|da|por|nosso|você)\b/gi,
  nl: /\b(het|een|van|en|voor|met|wij|jij|zijn|onze)\b/gi,
  it: /\b(il|gli|per|con|una|che|del|della|siamo|nostro)\b/gi,
  pl: /\b(i|w|z|na|dla|jest|się|oraz)\b/gi,
  sv: /\b(och|att|för|med|vi|du|är|som)\b/gi,
};

export function detectPostingLanguage(text: string): { lang: string; share: number } {
  const sample = text.slice(0, 5000);
  const counts = Object.entries(STOPWORDS).map(([lang, re]) => ({
    lang,
    n: (sample.match(re) ?? []).length,
  }));
  const total = counts.reduce((a, c) => a + c.n, 0) || 1;
  counts.sort((a, b) => b.n - a.n);
  return { lang: counts[0]!.lang, share: counts[0]!.n / total };
}

const LANG_NAMES: Record<string, string> = {
  en: "English", fr: "French", de: "German", es: "Spanish", pt: "Portuguese",
  nl: "Dutch", it: "Italian", pl: "Polish", sv: "Swedish",
};

export function checkFit(corpus: Corpus, job: Pick<NormalizedJob, "title" | "descriptionText">): FitVerdict {
  const title = job.title;

  // Level
  const above = ABOVE_LEVEL.find((re) => re.test(title));
  if (above) {
    return { ok: false, check: "level", reason: `title "${title}" is above current level (${above})` };
  }
  if (STAFF.test(title) && !FLAT_STAFF_TITLE.test(title)) {
    return { ok: false, check: "level", reason: `Staff-level title "${title}" — above current level` };
  }

  // New-graduate programmes want a degree finished within about a year, or due
  // within one. A candidate whose degrees are older, or years away, is not one:
  // "University Graduate 2026" and "Software Engineer - New Grad" postings were
  // set aside by hand before this check existed. Internships are not affected —
  // an enrolled student is eligible for those.
  const newGrad = title.match(/\bnew[- ]grad(uate)?s?\b|\buniversity graduate\b|\brecent graduates?\b|\bgraduate (programme|program|scheme)\b|\brec[ée]m[- ]formad[oa]s?\b/i);
  if (newGrad) {
    const year = new Date().getFullYear();
    const degrees = corpus.profile.education.filter((e) => e.form?.level !== "technical_high_school");
    const recent = degrees.some((e) => (e.status === "completed" ? year - e.end <= 1 : e.end - year <= 1));
    if (!recent) {
      const years = degrees.map((e) => `${e.end}${e.status === "in_progress" ? " (expected)" : ""}`).join(", ") || "none on file";
      return { ok: false, check: "level", reason: `"${newGrad[0]}" programme — degrees end ${years}, none recent or imminent` };
    }
  }

  // A business function that sits in the IT department is still not IT work:
  // "Analista Financeiro Pleno TI" and "Analista de Negócios Sr (TI)" came in on
  // the word "TI".
  const business = title.match(BUSINESS_FUNCTION);
  if (business) {
    return { ok: false, check: "title-tech", reason: `title is a ${business[0]} role — a business function, not IT or engineering` };
  }

  // Engineering outside the candidate's domain (electrical, mechanical …): an
  // "Early Career Electrical Engineer" ranked into the US junior batch.
  const domain = title.match(OUT_OF_DOMAIN);
  if (domain) {
    return { ok: false, check: "title-tech", reason: `title is ${domain[0]} engineering — outside software, infrastructure and security` };
  }

  // Postings reserved for a group (people with disabilities, women, Black
  // candidates…). Membership is not something to infer or assume for someone,
  // so these are set aside for the candidate to decide.
  const reserved = `${title}\n${job.descriptionText.slice(0, 1500)}`.match(RESERVED_AUDIENCE);
  if (reserved) {
    return { ok: false, check: "reserved-audience", reason: `posting is reserved: "${reserved[0]}" — left for the candidate to decide` };
  }

  const cit = job.descriptionText.match(CITIZENSHIP_REQUIRED);
  if (cit) {
    return { ok: false, check: "citizenship", reason: `requires "${cit[0]}" — a citizenship or security clearance not on the candidate's profile` };
  }

  // Title technology
  const held = new Set(
    Object.values(corpus.profile.skills).flat().map((s) => s.toLowerCase()),
  );
  for (const t of TITLE_TECH) {
    if (!t.re.test(title)) continue;
    const has = [...held].some((h) => h === t.name.toLowerCase() || h.startsWith(`${t.name.toLowerCase()} `));
    if (!has) {
      return { ok: false, check: "title-tech", reason: `title requires ${t.name}, not in declared skills` };
    }
  }

  // Posting language — acceptable if the candidate is native/C1 in it, plus Spanish,
  // which the LATAM document policy explicitly targets.
  const fluent = new Set(
    corpus.profile.languages
      .filter((l) => /native|c1|c2|fluent/i.test(l.level))
      .map((l) => l.language),
  );
  fluent.add("Spanish");
  const detected = detectPostingLanguage(`${title}\n${job.descriptionText}`);
  const name = LANG_NAMES[detected.lang] ?? detected.lang;
  if (detected.share >= 0.45 && !fluent.has(name)) {
    return {
      ok: false,
      check: "posting-language",
      reason: `posting is written in ${name} (${Math.round(detected.share * 100)}% of function words) — working language outside declared fluency`,
    };
  }

  return { ok: true, check: "pass", reason: "within level, title tech held, posting language workable" };
}
