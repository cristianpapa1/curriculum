/**
 * Anti-fabrication gate.
 *
 * With autonomous submission enabled, this file is the only thing standing
 * between a generation bug and a fabricated claim reaching a hiring manager. Fabrications surface at interview and can get offers
 * rescinded — strictly worse than not applying — so this check is mechanical,
 * not a matter of the generator's good behaviour.
 *
 * A failure blocks THAT application only. The pipeline continues (ISC-17).
 *
 * Three independent checks:
 *   1. TECHNOLOGY  — a known tech term appears that the corpus never mentions
 *   2. METRIC      — a number appears that no claim `source` supports
 *   3. OVER-CLAIM  — a skill is claimed above its declared level, or a declared
 *                    gap is claimed at all
 */

import type { Corpus, SkillLevel } from "../corpus/types.ts";

export type ViolationKind = "technology" | "metric" | "over-claim" | "gap";

export interface Violation {
  kind: ViolationKind;
  term: string;
  detail: string;
}

export interface GateResult {
  ok: boolean;
  violations: Violation[];
}

/**
 * Technologies a CV generator might plausibly hallucinate. Only terms in this
 * vocabulary are policed, which keeps the check precise: we are not doing
 * open-ended entity recognition, we are asking "did it name a tool the candidate
 * has never touched?"
 */
const TECH_VOCAB = [
  "kubernetes", "k8s", "openshift", "helm", "istio", "rancher",
  "golang", "rust", "java", "scala", "ruby", "rails", "php", "laravel",
  "c#", ".net", "elixir", "kotlin", "swift", "perl", "haskell",
  "django", "flask", "spring boot", "express", "nestjs", "svelte", "angular", "vue",
  "gcp", "google cloud", "digitalocean", "heroku", "linode", "openstack",
  "mongodb", "cassandra", "dynamodb", "redis", "elasticsearch", "neo4j",
  "snowflake", "databricks", "bigquery", "redshift", "clickhouse",
  "kafka", "rabbitmq", "pulsar", "airflow", "dbt", "spark", "hadoop", "flink",
  "pytorch", "tensorflow", "keras", "scikit-learn", "hugging face", "langchain",
  "jenkins", "circleci", "travis", "bamboo", "teamcity", "argocd", "flux",
  "splunk", "qradar", "sentinel", "crowdstrike", "sentinelone", "carbon black",
  "palo alto", "fortinet", "checkpoint", "cisco asa", "juniper",
  "okta", "ping identity", "sailpoint", "cyberark", "hashicorp vault",
  "soc 2", "pci dss", "hipaa", "fedramp", "gdpr", "sox",
  "graphql", "grpc", "websocket", "kafka streams",
  "salesforce", "sap", "workday", "servicenow",
  "pandas", "numpy", "jupyter",
];

/** Phrasing that asserts mastery — used for the over-claim check. */
const MASTERY_PATTERNS = [
  /\b(expert|expertise|mastery|advanced|deep expertise|specialist)\s+(?:in|with|at|on)\s+([A-Za-z0-9+#./ -]{2,30})/gi,
  /\b([A-Za-z0-9+#./-]{2,30})\s+(?:expert|specialist)\b/gi,
];

const LEVEL_RANK: Record<SkillLevel, number> = {
  expert: 4,
  proficient: 3,
  intermediate: 2,
  familiar: 1,
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[‐-―]/g, "-").replace(/\s+/g, " ");
}

/**
 * Everything the corpus actually attests: claim text, every variant, every
 * `source` quote, declared skills, employers, certifications.
 */
function buildAttestedText(corpus: Corpus): string {
  const parts: string[] = [];
  for (const c of corpus.claims) {
    parts.push(c.claim, c.source, ...Object.values(c.variants ?? {}), ...c.skills);
    if (c.metric) parts.push(c.metric);
    if (c.scope) parts.push(c.scope);
  }
  // Identity must be attested too, or the metric check fires on the digits in
  // the phone number and blocks every document ever rendered.
  parts.push(...Object.values(corpus.profile.identity));
  for (const list of Object.values(corpus.profile.skills)) parts.push(...list);
  for (const e of corpus.profile.employment) {
    // Dates included: a rendered role block shows them, and they are facts.
    parts.push(e.employer, e.title_official, e.context, e.start, e.end ?? "");
  }
  for (const cert of corpus.profile.certifications) parts.push(cert.name);
  for (const ed of corpus.profile.education) {
    parts.push(ed.institution, ed.degree, String(ed.start), String(ed.end));
  }
  for (const l of corpus.profile.languages) parts.push(l.language, l.level);
  return normalize(parts.join("\n"));
}

/** Numbers the corpus supports, as bare digit strings. */
function buildAttestedNumbers(corpus: Corpus): Set<string> {
  const attested = buildAttestedText(corpus);
  const nums = new Set<string>();
  for (const m of attested.matchAll(/\d[\d,.]*/g)) {
    nums.add(m[0].replace(/[,.]$/, ""));
  }
  // Years from education/employment are legitimately renderable.
  for (const ed of corpus.profile.education) {
    nums.add(String(ed.start));
    nums.add(String(ed.end));
  }
  return nums;
}

export function checkAntiFabrication(
  rendered: string,
  corpus: Corpus,
): GateResult {
  const text = normalize(rendered);
  const attested = buildAttestedText(corpus);
  const attestedNumbers = buildAttestedNumbers(corpus);
  const violations: Violation[] = [];

  // ── 1. TECHNOLOGY ────────────────────────────────────────────────────────
  for (const tech of TECH_VOCAB) {
    // Word-boundary match so "go" doesn't fire on "governance".
    const re = new RegExp(`(?:^|[^a-z0-9+#.])${escapeRe(tech)}(?:[^a-z0-9+#-]|$)`, "i");
    if (re.test(text) && !attested.includes(tech)) {
      violations.push({
        kind: "technology",
        term: tech,
        detail: `"${tech}" appears in the rendered text but is not attested anywhere in the corpus`,
      });
    }
  }

  // ── 2. METRIC ────────────────────────────────────────────────────────────
  // Dates are not claims. The cover letter carries today's date, and without
  // this strip its day-of-month was checked as a metric: it passed on the 11th
  // only because "11" happens to appear in the phone number, and blocked every
  // letter on the 14th. Remove ISO and slash dates before scanning.
  const metricText = text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, " ");
  for (const m of metricText.matchAll(/\b(\d[\d,]*)\+?\b/g)) {
    // Group 1 is guaranteed by the pattern, but `noUncheckedIndexedAccess`
    // types it as possibly-undefined — skip rather than assert.
    const captured = m[1];
    if (captured === undefined) continue;
    const raw = captured.replace(/,$/, "");
    // Ignore trivially small numbers — list counters, "3 regions" style prose
    // that is already covered by the technology and over-claim checks.
    if (Number(raw.replace(/,/g, "")) < 10) continue;
    if (!attestedNumbers.has(raw) && !attested.includes(raw)) {
      violations.push({
        kind: "metric",
        term: raw,
        detail: `the number "${raw}" is not supported by any claim source`,
      });
    }
  }

  // ── 3. OVER-CLAIM + GAPS ─────────────────────────────────────────────────
  for (const gap of corpus.profile.gaps) {
    const g = normalize(gap.skill);
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(g)}(?:[^a-z0-9]|$)`, "i");
    if (re.test(text)) {
      violations.push({
        kind: "gap",
        term: gap.skill,
        detail: `declared gap claimed: ${gap.note}`,
      });
    }
  }

  for (const pattern of MASTERY_PATTERNS) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      const claimed = (m[2] ?? m[1] ?? "").trim();
      if (!claimed) continue;
      const level = findDeclaredLevel(claimed, corpus);
      if (level && LEVEL_RANK[level] < LEVEL_RANK.expert) {
        violations.push({
          kind: "over-claim",
          term: claimed,
          detail: `claimed as expert-level but declared "${level}" in profile.yaml`,
        });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

function findDeclaredLevel(phrase: string, corpus: Corpus): SkillLevel | null {
  const p = normalize(phrase);
  for (const [skill, level] of corpus.skillLevels) {
    if (p === skill) return level;
    // Whole words only. Substring matching let a two-letter skill answer for a
    // word that merely contains it: with "Go" declared, the heading "Security
    // Compliance & Governance Specialist" read as Go claimed above its level.
    if (matchesWord(skill, p) || matchesWord(p, skill)) return level;
  }
  return null;
}

/** Does `needle` appear in `haystack` as a whole word? */
function matchesWord(needle: string, haystack: string): boolean {
  if (needle.length === 0) return false;
  return new RegExp(`(^|[^a-z0-9+#])${escapeRe(needle)}($|[^a-z0-9+#])`, "i").test(haystack);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatViolations(violations: Violation[]): string {
  return violations
    .map((v) => `  [${v.kind}] ${v.term} — ${v.detail}`)
    .join("\n");
}
