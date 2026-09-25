/**
 * CV renderer.
 *
 * Renders the corpus, projected toward a requested angle, into a CV. Rendering
 * is DETERMINISTIC and composed only of corpus text — no free generation — so
 * the output cannot contain a fact the corpus does not attest. That is what
 * lets the anti-fabrication gate be a cheap final assertion rather than the
 * only line of defence.
 *
 * Two hard rules encoded here:
 *   - the word "Junior" never appears unless explicitly requested (ISC-18)
 *   - an in-progress degree renders as in-progress, never as earned (ISC-19)
 */

import type { Corpus, EducationEntry } from "../corpus/types.ts";
import type { Angle } from "../position/angles.ts";
import { resolveAngle } from "../position/angles.ts";
import { project, requirementBoost, type ProjectedClaim, type RequirementEvidence } from "../position/project.ts";
import { escapeHtml, htmlDocument } from "./style.ts";
import { relevantCertifications } from "../pipeline/certifications.ts";
import {
  CHROME, LANGUAGE_NAMES, LEVEL_NAMES, CV_TITLES, DEFAULT_TITLE,
  SUMMARY_FRAME, SUMMARY_STACK, INDEPENDENT_PROJECT, joinList, localizeMetric, type Lang,
} from "./locale.ts";

const MISSING_TRANSLATION = "canonical:MISSING-TRANSLATION";

export interface CVOptions {
  /** Max experience bullets per employer. */
  bulletsPerRole?: number;
  /** Total claims to draw from the projection. */
  claimPool?: number;
  /** Set true ONLY if the operator explicitly wants a junior framing. */
  allowJuniorFraming?: boolean;
  /** Role title from the posting, used to sharpen the subtitle. */
  targetTitle?: string;
  /** Requested document language. Falls back to English if coverage is partial. */
  lang?: Lang;
  /**
   * Surface the EU work-authorization line. Set for EU/EEA-based roles, where
   * "no sponsorship required" is the single strongest filter-passing fact in
   * the profile.
   */
  showWorkAuthorization?: boolean;
  /**
   * Skills the posting explicitly asks for. Drives skill ordering and the
   * highlights line, so the CV answers THIS job rather than a job family.
   */
  requiredSkills?: string[];
  /**
   * The posting's requirements with the claims that evidence each one (from
   * scoreJob). Re-ranks bullets toward what this team asks for.
   */
  requirements?: RequirementEvidence[];
  /**
   * The posting's title and requirement terms (`postingSignals`). When given,
   * the certifications section lists only certifications related to them, and
   * is left out when none are — a candidate who lists unrelated certifications
   * reads as padding the page.
   */
  postingSignals?: string;
}

export interface CVDocument {
  title: string;
  markdown: string;
  html: string;
  /** Claim ids that made it into the document — provenance for meta.json. */
  claimIds: string[];
  angleId: string | null;
  /** Language actually rendered. */
  lang: Lang;
  /** Set when `lang` differs from what was requested, with the reason. */
  langFallbackReason: string | null;
}

const DEFAULTS: Required<Pick<CVOptions, "bulletsPerRole" | "claimPool">> = {
  bulletsPerRole: 6,
  claimPool: 18,
};

/** Role headline in the document language, falling back to the angle default. */
function titleFor(angle: Angle | null, lang: Lang): string {
  if (!angle) return DEFAULT_TITLE[lang];
  return CV_TITLES[lang][angle.id] ?? angle.cvTitle;
}

/** Years of professional experience, derived from the earliest employment. */
function yearsOfExperience(corpus: Corpus, currentOnly = false): number {
  const starts = corpus.profile.employment
    .filter((e) => !currentOnly || e.current)
    .map((e) => Date.parse(`${e.start}-01`))
    .filter((n) => !Number.isNaN(n));
  if (starts.length === 0) return 0;
  const earliest = Math.min(...starts);
  return Math.floor((Date.now() - earliest) / (365.25 * 24 * 3600 * 1000));
}

/**
 * Profile skills the posting names, strongest requirement first — expert and
 * proficient only, so a headline or "hands-on with" sentence never leans on a
 * skill held at working-knowledge level. Display names drop the parenthetical
 * ("AWS (IAM, core services)" → "AWS").
 */
export function heldRequiredSkills(
  corpus: Corpus,
  requirements: RequirementEvidence[] = [],
  requiredSkills: string[] = [],
  limit = 5,
): string[] {
  const terms = requirements.length > 0
    ? [...requirements].filter((r) => r.matched).sort((a, b) => b.weight - a.weight).map((r) => r.term.toLowerCase())
    : requiredSkills.map((s) => s.toLowerCase());
  // Ticketing and office tools are real skills but weak headline material.
  const GENERIC = new Set(["jira", "power bi", "windows"]);
  const held = [...corpus.profile.skills.expert, ...corpus.profile.skills.proficient]
    .filter((s) => !GENERIC.has(s.toLowerCase()));
  const out: string[] = [];
  for (const term of terms) {
    if (term.length < 2) continue;
    const hit = held.find((s) => {
      const low = s.toLowerCase();
      return low === term || (term.length >= 3 && (low.includes(term) || term.includes(low)));
    });
    if (!hit) continue;
    const display = hit.replace(/\s*\([^)]*\)\s*/g, " ").trim();
    if (!out.includes(display)) out.push(display);
    if (out.length >= limit) break;
  }
  return out;
}

function renderEducationLine(e: EducationEntry, lang: Lang = "en"): string {
  if (e.status === "in_progress") {
    // ISC-19 — never render an unfinished degree as a held credential.
    return `${e.degree} — ${CHROME[lang].inProgress} ${e.end}`;
  }
  return `${e.degree} — ${e.start}–${e.end}`;
}

/**
 * Deterministic summary: profile facts, the posting's technologies the candidate
 * works in, and the strongest relevant claim not already shown as a highlight.
 * No generative text, so nothing to hallucinate — and no sentence repeated
 * verbatim three lines further down.
 */
function buildSummary(
  corpus: Corpus,
  angle: Angle | null,
  candidates: ProjectedClaim[],
  stack: string[],
  lang: Lang,
): { text: string; claimId: string | null } {
  const years = yearsOfExperience(corpus);
  const recent = yearsOfExperience(corpus, true);
  const role = titleFor(angle, lang);
  const lead = candidates[0];
  const parts = [
    SUMMARY_FRAME[lang](role, years, recent),
    stack.length > 0 ? SUMMARY_STACK[lang](joinList(stack, lang)) : "",
    lead?.text.replace(/\s+/g, " ").trim() ?? "",
  ].filter(Boolean);
  return { text: parts.join(" "), claimId: lead?.claim.id ?? null };
}

/**
 * Skills ordered by what THIS posting asks for.
 *
 * Two failures this fixes. First, ordering by angle alone buries a skill the
 * job explicitly names behind one it merely implies — and an ATS scores on the
 * posting's own keywords, not on our taxonomy. Second, the readability cap was
 * a blind `slice()`, so a required skill sitting at position 15 was silently
 * deleted from the CV of the one job that asked for it.
 *
 * Required-and-held skills now lead every row and are never cut. Nothing is
 * invented: a skill only appears if it is already declared in profile.yaml.
 */
function buildSkillRows(
  corpus: Corpus,
  used: ProjectedClaim[],
  t: import("./locale.ts").ChromeStrings,
  requiredSkills: string[] = [],
): { label: string; items: string[]; matched: string[] }[] {
  const required = new Set(requiredSkills.map((s) => s.toLowerCase()));

  const emphasised = new Set<string>();
  for (const p of used) for (const s of p.claim.skills) emphasised.add(s);

  const isRequired = (s: string) => {
    const low = s.toLowerCase();
    if (required.has(low)) return true;
    // "AWS (IAM, core services)" should match a posting asking for "aws".
    for (const r of required) {
      if (r.length >= 3 && (low.includes(r) || r.includes(low))) return true;
    }
    return false;
  };

  const order = (list: string[], cap: number) => {
    const hit = list.filter(isRequired);
    const viaClaims = list.filter((s) => !isRequired(s) && emphasised.has(s));
    const rest = list.filter((s) => !isRequired(s) && !emphasised.has(s));
    // The cap trims the tail only — a required skill is never dropped.
    return [...hit, ...[...viaClaims, ...rest].slice(0, Math.max(0, cap - hit.length))];
  };

  // A skill listed at two levels renders once, at the higher one.
  const seen = new Set<string>();
  const once = (list: string[]) => list.filter((s) => !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
  const rows = [
    { label: t.core, items: order(once(corpus.profile.skills.expert), 99) },
    { label: t.proficient, items: order(once(corpus.profile.skills.proficient), 14) },
    { label: t.working, items: order(once(corpus.profile.skills.intermediate), 12) },
  ];

  return rows
    .map((r) => ({ ...r, matched: r.items.filter(isRequired) }))
    .filter((r) => r.items.length > 0);
}

const NUMBER_WORDS: Record<string, RegExp> = {
  "2": /\b(two|dois|duas|dos)\b/i,
  "3": /\b(three|três|tres)\b/i,
  "4": /\b(four|quatro|cuatro)\b/i,
  "6": /\b(six|seis)\b/i,
};

/**
 * The wording of a claim that actually states its metric.
 *
 * Found in review: "**3 system classes unified** — Built a full-stack internal
 * platform end to end…" — the bold figure described one variant, the sentence
 * next to it came from another, and nothing in the sentence said "three".
 * A highlight whose number the reader cannot find in its own sentence reads as
 * padding. Returns null when no available wording carries the number.
 */
function textStatingMetric(p: ProjectedClaim, lang: Lang): string | null {
  const metric = p.claim.metric ?? "";
  const num = metric.match(/\d[\d,.]*/)?.[0];
  const states = (t: string) =>
    !num || t.includes(num) || (NUMBER_WORDS[num]?.test(t) ?? false);
  // Eligibility is decided on the English wordings so every language picks the
  // same highlights; a translation renders the canonical text of a claim whose
  // English form was verified to carry the figure.
  const english = [...(lang === "en" ? [p.text] : []), p.claim.claim, ...Object.values(p.claim.variants ?? {})]
    .map((t) => t.replace(/\s+/g, " ").trim());
  const hit = english.find(states);
  if (!hit) return null;
  return lang === "en" ? hit : p.text.replace(/\s+/g, " ").trim();
}

interface Highlight {
  p: ProjectedClaim;
  text: string;
}

/**
 * Three concrete, quantified achievements for the top of the page.
 *
 * A hiring manager gives a CV a handful of seconds. A summary paragraph of
 * prose is read as texture; a short line of hard numbers is read as fact. These
 * are drawn from claims that carry a `metric`, ranked by relevance to the
 * posting, so the figures that lead are the ones this employer cares about.
 */
function buildHighlights(
  projected: ProjectedClaim[],
  lang: Lang,
  requiredSkills: string[] = [],
  limit = 3,
): Highlight[] {
  const required = requiredSkills.map((s) => s.toLowerCase());
  const withMetric = projected
    .filter((p) => p.claim.metric)
    .map((p) => ({ p, text: textStatingMetric(p, lang) }))
    .filter((h): h is Highlight => h.text !== null);
  if (required.length === 0) return withMetric.slice(0, limit);

  // Re-rank by how much each achievement overlaps what THIS posting asks for.
  // Without this the highlights follow the angle alone and come out identical
  // for two very different jobs — which defeats the point of leading with them.
  const overlap = ({ p }: Highlight) => {
    const hay = `${p.claim.skills.join(" ")} ${p.claim.domains.join(" ")} ${p.claim.claim}`.toLowerCase();
    return required.reduce((n, r) => (r.length >= 3 && hay.includes(r) ? n + 1 : n), 0);
  };

  return [...withMetric]
    .map((h) => ({ h, hits: overlap(h) }))
    // Relevance to the posting first, then the projection's own ordering.
    .sort((a, b) => b.hits - a.hits || projected.indexOf(a.h.p) - projected.indexOf(b.h.p))
    .slice(0, limit)
    .map((x) => x.h);
}

/** Certifications whose domains overlap the angle come first. */
function orderCertifications(corpus: Corpus, angle: Angle | null) {
  const certs = [...corpus.profile.certifications];
  if (!angle) return certs;
  const weights = angle.domains;
  return certs.sort((a, b) => {
    const wa = Math.max(0, ...a.domains.map((d) => weights[d] ?? 0));
    const wb = Math.max(0, ...b.domains.map((d) => weights[d] ?? 0));
    return wb - wa || a.name.localeCompare(b.name);
  });
}

export function renderCV(
  corpus: Corpus,
  angleInput: string | null,
  options: CVOptions = {},
): CVDocument {
  const opts = { ...DEFAULTS, ...options };
  const angle = resolveAngle(angleInput);
  const claimBoost = requirementBoost(opts.requirements);

  // Language resolution. A document is rendered in the requested language ONLY
  // if every claim it would use is translated; otherwise the whole document
  // falls back to English. A CV with three Portuguese bullets and two English
  // ones reads as broken, which is worse than an English CV.
  const requested: Lang = opts.lang ?? "en";
  let lang: Lang = requested;
  let langFallbackReason: string | null = null;

  let projection = project(corpus, angleInput, { limit: opts.claimPool, lang, claimBoost });
  if (requested !== "en") {
    const untranslated = projection.claims.filter(
      (p) => p.variantUsed === MISSING_TRANSLATION,
    );
    if (untranslated.length > 0) {
      lang = "en";
      langFallbackReason =
        `${untranslated.length} of ${projection.claims.length} selected claims have no ` +
        `${requested} translation (${untranslated.slice(0, 3).map((p) => p.claim.id).join(", ")}` +
        `${untranslated.length > 3 ? ", …" : ""}) — rendered in English rather than mixed`;
      projection = project(corpus, angleInput, { limit: opts.claimPool, lang: "en", claimBoost });
    }
  }

  const t = CHROME[lang];
  const id = corpus.profile.identity;

  // Highlights are chosen first, and whatever leads the page is not repeated
  // below it: the reviewed batch showed the same sentence in the summary, the
  // highlights and the cover letter's first paragraph.
  const highlights = buildHighlights(projection.claims, lang, opts.requiredSkills ?? []);
  const highlighted = new Set(highlights.map((h) => h.p.claim.id));
  const afterHighlights = projection.claims.filter((p) => !highlighted.has(p.claim.id));

  const stack = heldRequiredSkills(corpus, opts.requirements, opts.requiredSkills, 5);
  const summary = buildSummary(corpus, angle, afterHighlights, stack, lang);
  const body = afterHighlights.filter((p) => p.claim.id !== summary.claimId);

  // Group by employer, preserving rank order within each group. Claims with no
  // employer are independent work and get their own section — before this they
  // could lead the summary while never appearing anywhere a reader could place them.
  const byEmployer = new Map<string, ProjectedClaim[]>();
  for (const p of body) {
    const key = p.claim.employer ?? "_personal";
    const list = byEmployer.get(key) ?? [];
    if (list.length < opts.bulletsPerRole) list.push(p);
    byEmployer.set(key, list);
  }
  const projects = (byEmployer.get("_personal") ?? []).slice(0, 4);

  // Current role first, then reverse-chronological.
  const employments = [...corpus.profile.employment].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return b.start.localeCompare(a.start);
  });

  const used: ProjectedClaim[] = [...highlights.map((h) => h.p)];
  const summaryClaim = afterHighlights.find((p) => p.claim.id === summary.claimId);
  if (summaryClaim) used.push(summaryClaim);
  for (const e of employments) used.push(...(byEmployer.get(e.id) ?? []));
  used.push(...projects);

  const skillRows = buildSkillRows(corpus, used, t, opts.requiredSkills ?? []);
  const certs = opts.postingSignals === undefined
    ? orderCertifications(corpus, angle)
    : relevantCertifications(corpus, opts.postingSignals);
  const role = titleFor(angle, lang);
  // The headline carries the posting's own top technologies: it is the one
  // line every recruiter and every ATS reads.
  const subtitle = stack.length > 0 ? `${role} · ${stack.slice(0, 3).join(" · ")}` : role;

  const provenance = (p: ProjectedClaim) =>
    corpus.profile.employment.find((e) => e.id === p.claim.employer)?.employer ?? INDEPENDENT_PROJECT[lang];
  const contact = [id.location, id.email, id.phone, id.website, id.github, id.linkedin].filter(Boolean) as string[];
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();

  // ── Markdown ───────────────────────────────────────────────────────────
  const md: string[] = [];
  md.push(`# ${id.name}`);
  md.push(`**${subtitle}**`);
  const authLine = opts.showWorkAuthorization
    ? corpus.profile.eligibility.eu_work_authorization_statement
    : null;
  if (authLine) md.push(`_${authLine}_`);
  md.push(contact.join(" · "));
  md.push(`\n## ${t.summary}\n\n${summary.text}`);
  if (highlights.length > 0) {
    md.push(`\n## ${t.highlights}\n`);
    for (const h of highlights) {
      md.push(`- **${localizeMetric(h.p.claim.metric ?? "", lang)}** — ${h.text} _(${provenance(h.p)})_`);
    }
  }
  md.push(`\n## ${t.experience}`);
  for (const e of employments) {
    const bullets = byEmployer.get(e.id) ?? [];
    if (bullets.length === 0) continue;
    const dates = `${e.start} – ${e.end ?? t.present}`;
    md.push(`\n### ${e.title_official} · ${e.employer}  \n*${dates}*\n`);
    for (const b of bullets) md.push(`- ${flat(b.text)}`);
  }
  if (projects.length > 0) {
    md.push(`\n## ${t.projects}\n`);
    md.push([id.hub, id.github].filter(Boolean).join(" · ") + "\n");
    for (const p of projects) md.push(`- ${flat(p.text)}`);
  }
  md.push(`\n## ${t.skills}`);
  for (const row of skillRows) md.push(`- **${row.label}:** ${row.items.join(", ")}`);
  if (certs.length) {
    md.push(`\n## ${t.certifications}`);
    for (const c of certs) md.push(`- ${c.name}`);
  }
  md.push(`\n## ${t.education}`);
  for (const e of corpus.profile.education) {
    md.push(`- **${e.institution}** — ${renderEducationLine(e, lang)}`);
  }
  md.push(`\n## ${t.languages}`);
  md.push(
    corpus.profile.languages
      .map((l) => `${LANGUAGE_NAMES[lang][l.language] ?? l.language} (${LEVEL_NAMES[lang][l.level] ?? l.level}${l.certified ? `, ${t.certified}` : ""})`)
      .join(" · "),
  );

  // ── HTML ───────────────────────────────────────────────────────────────
  const link = (url: string) => `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
  const h: string[] = [];
  h.push(`<h1>${escapeHtml(id.name)}</h1>`);
  h.push(`<div class="subtitle">${escapeHtml(subtitle)}</div>`);
  if (authLine) {
    h.push(`<div class="workauth">${escapeHtml(authLine)}</div>`);
  }
  h.push(
    `<div class="contact">` +
      contact
        .map((c) => (c === id.email ? `<a href="mailto:${escapeHtml(c)}">${escapeHtml(c)}</a>` : /^https?:/.test(c) ? link(c) : escapeHtml(c)))
        .join(`<span class="sep">|</span>`) +
      `</div>`,
  );
  h.push(`<h2>${escapeHtml(t.summary)}</h2><p class="summary">${escapeHtml(summary.text)}</p>`);

  if (highlights.length > 0) {
    h.push(`<h2>${escapeHtml(t.highlights)}</h2><ul class="highlights">`);
    for (const hl of highlights) {
      h.push(
        `<li><span class="metric">${escapeHtml(localizeMetric(hl.p.claim.metric ?? "", lang))}</span> — ` +
          `${escapeHtml(hl.text)} <span class="muted">(${escapeHtml(provenance(hl.p))})</span></li>`,
      );
    }
    h.push(`</ul>`);
  }
  h.push(`<h2>${escapeHtml(t.experience)}</h2>`);
  for (const e of employments) {
    const bullets = byEmployer.get(e.id) ?? [];
    if (bullets.length === 0) continue;
    h.push(`<div class="role">`);
    h.push(
      `<div class="role-head"><div><span class="role-title">${escapeHtml(e.title_official)}</span>` +
        `<span class="sep"> · </span><span class="role-org">${escapeHtml(e.employer)}</span></div>` +
        `<div class="role-dates">${escapeHtml(e.start)} – ${escapeHtml(e.end ?? t.present)}</div></div>`,
    );
    h.push(`<ul>`);
    for (const b of bullets) h.push(`<li>${escapeHtml(flat(b.text))}</li>`);
    h.push(`</ul></div>`);
  }

  if (projects.length > 0) {
    h.push(`<h2>${escapeHtml(t.projects)}</h2><div class="role">`);
    const links = [id.hub, id.github].filter(Boolean) as string[];
    h.push(`<div class="contact">${links.map(link).join(`<span class="sep">|</span>`)}</div><ul>`);
    for (const p of projects) h.push(`<li>${escapeHtml(flat(p.text))}</li>`);
    h.push(`</ul></div>`);
  }

  h.push(`<h2>${escapeHtml(t.skills)}</h2>`);
  for (const row of skillRows) {
    h.push(
      `<div class="skills-row"><span class="skills-label">${escapeHtml(row.label)}:</span> ` +
        `${escapeHtml(row.items.join(", "))}</div>`,
    );
  }

  if (certs.length) {
    h.push(`<h2>${escapeHtml(t.certifications)}</h2><div class="cols2">`);
    for (const c of certs) h.push(`<div class="cert-item">${escapeHtml(c.name)}</div>`);
    h.push(`</div>`);
  }

  h.push(`<h2>${escapeHtml(t.education)}</h2>`);
  for (const e of corpus.profile.education) {
    h.push(
      `<div class="edu-item"><span class="edu-inst">${escapeHtml(e.institution)}</span> — ` +
        `<span class="muted">${escapeHtml(renderEducationLine(e, lang))}</span></div>`,
    );
  }

  h.push(`<h2>${escapeHtml(t.languages)}</h2><div>`);
  h.push(
    escapeHtml(
      corpus.profile.languages
        .map((l) => `${LANGUAGE_NAMES[lang][l.language] ?? l.language} (${LEVEL_NAMES[lang][l.level] ?? l.level}${l.certified ? `, ${t.certified}` : ""})`)
        .join("  |  "),
    ),
  );
  h.push(`</div>`);

  const markdown = md.join("\n");
  const html = htmlDocument(`${id.name} — ${role}`, h.join("\n"));

  // ISC-18 — fail loudly rather than quietly shipping a self-downgrade.
  if (!opts.allowJuniorFraming && /\bjunior\b/i.test(markdown)) {
    throw new Error(
      'rendered CV contains "Junior" but allowJuniorFraming was not set — ' +
        "this downgrades a senior-scope profile into the most saturated applicant pool",
    );
  }

  return {
    title: `${id.name} — ${role}`,
    markdown,
    html,
    claimIds: used.map((p) => p.claim.id),
    angleId: angle?.id ?? null,
    lang,
    langFallbackReason,
  };
}
