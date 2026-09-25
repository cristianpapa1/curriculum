/**
 * Job match scoring.
 *
 * Deterministic and explainable by design: the score is coverage of the
 * posting's detectable requirements by attested corpus evidence, and every
 * matched requirement cites the claim ids that satisfy it (ISC-28). No model
 * call, so the number is reproducible and auditable — and a low score can be
 * explained to the candidate in terms of which requirements had no evidence.
 *
 * It also suggests an angle, which is what lets a run say "find me anything I
 * fit" rather than requiring the angle up front.
 */

import type { Corpus } from "../corpus/types.ts";
import type { NormalizedJob } from "../ats/types.ts";
import { ANGLES, resolveAngle, type Angle } from "../position/angles.ts";
import { project } from "../position/project.ts";

export interface RequirementMatch {
  term: string;
  matched: boolean;
  /** Claim ids that evidence this requirement. */
  viaClaims: string[];
  /** Declared skill level backing it, when the match came from the profile. */
  viaSkillLevel: string | null;
  weight: number;
}

export interface JobScore {
  /** 0-100 overall fit: coverage × role-family fit × vocabulary depth. */
  score: number;
  /** Raw requirement coverage before the role and depth adjustments. */
  coverage: number;
  roleFamily: RoleFamily;
  roleFit: number;
  roleReason: string;
  /** 0-1 confidence that the posting is technical enough to score meaningfully. */
  depth: number;
  criticalPresent: number;
  matches: RequirementMatch[];
  matchedCount: number;
  totalCount: number;
  /** Best-fitting angle inferred from title and body. */
  suggestedAngle: string | null;
  angleScores: { angle: string; score: number }[];
  /** Requirements with no corpus evidence — the honest gap list. */
  gaps: string[];
}

/** Requirement phrases worth detecting beyond the corpus's own skill names. */
const EXTRA_TERMS = [
  "terraform", "ansible", "docker", "python", "typescript", "javascript",
  "react", "fastapi", "next.js", "postgresql", "sqlite", "bash", "powershell",
  "linux", "windows", "vmware", "oracle cloud", "oci", "azure", "aws",
  "entra id", "active directory", "rbac", "least privilege", "sso", "saml", "oauth",
  "iso 27001", "soc 2", "nist", "compliance", "audit", "governance",
  "siem", "incident response", "vulnerability", "forensics", "endpoint",
  "firewall", "vpn", "ipsec", "networking", "dns",
  "ci/cd", "github actions", "gitlab ci", "pipeline",
  "datadog", "prometheus", "observability", "monitoring", "telemetry",
  "iam", "identity", "access management", "provisioning", "deprovisioning",
  "automation", "scripting", "api", "rest", "integration",
  "infrastructure as code", "iac", "cloud", "devops", "sre", "platform",
  "mcp", "llm", "ai", "agent",
  "power bi", "reporting", "dashboard",

  // Technologies a candidate may NOT have. They belong in the vocabulary
  // precisely for that: it is otherwise built from the corpus, so it could only
  // ever report requirements the candidate meets, and the `gaps` list — the
  // honest half of the score — would always be empty.
  "kubernetes", "k8s", "helm", "openshift", "istio",
  "go", "golang", "java", "ruby", "rust", "scala", "c#", ".net", "php", "kotlin",
  "gcp", "google cloud",
  "kafka", "rabbitmq", "airflow", "spark", "dbt", "snowflake",
  "mongodb", "cassandra", "dynamodb", "redis", "elasticsearch",
  "jenkins", "argocd", "circleci",
  "splunk", "crowdstrike", "okta", "sailpoint", "cyberark", "vault",
  "pytorch", "tensorflow", "langchain",
  "graphql", "grpc",
  "soc 2", "pci dss", "hipaa", "fedramp", "gdpr",
];

const CRITICAL_TERMS = new Set([
  "terraform", "ansible", "python", "iam", "iso 27001", "siem", "docker",
  "aws", "azure", "oci", "kubernetes",
]);

/**
 * Role-family gate.
 *
 * Without this, coverage scoring is trivially gamed by a posting that lists
 * almost no technical requirements: a Sales Ops Analyst JD mentioning six
 * detectable terms, all of which the candidate has, scores 100/100. The denominator
 * was never the job's difficulty — it was the job's technical vocabulary.
 *
 * So the title decides the family first, and coverage is scaled by it.
 */
const ENGINEERING_TITLE = [
  /\bengineer(ing)?\b/i, /\bdeveloper\b/i, /\bdev\s?ops\b/i, /\bsre\b/i,
  /\bsite reliability\b/i, /\binfrastructure\b/i, /\bplatform\b/i,
  /\bsysadmin\b/i, /\bsystems? admin/i, /\badministrator\b/i,
  /\bsecurity\b/i, /\bcloud\b/i, /\bautomation\b/i, /\bidentity\b/i,
  /\biam\b/i, /\bnetwork\b/i, /\bobservability\b/i, /\bcompliance\b/i,
  /\bgrc\b/i, /\bincident\b/i, /\bsoc\b/i, /\btechnical\b/i,
  // Entry-level technical titles.
  /\bit (support|analyst|specialist|technician|operations)\b/i, /\bhelp ?desk\b/i,
  /\bservice desk\b/i, /\btechnical support\b/i, /\bsystems? analyst\b/i,
  /\bcyber\s?security\b/i, /\binformation security\b/i, /\bthreat\b/i, /\bvulnerabilit/i,
  // Portuguese / Spanish titles — Brazilian and LATAM boards post in them.
  /\bengenheir[oa]\b/i, /\bdesenvolvedor(a)?\b/i, /\bsegurança\b/i, /\bseguridad\b/i,
  /\binfraestrutura\b/i, /\binfraestructura\b/i, /\bredes\b/i, /\bsuporte\b/i, /\bsoporte\b/i,
  /\banalista de (sistemas|segurança|infraestrutura|ti|redes|suporte|dados|cloud|nuvem|devops)/i,
  /\bingenier[oa]\b/i, /\bdesarrollador(a)?\b/i, /\bnuvem\b/i,
];

const NON_ENGINEERING_TITLE = [
  /\bsales\b/i, /\baccount (executive|manager|director)\b/i, /\bbdr\b/i, /\bsdr\b/i,
  /\brecruit(er|ing)\b/i, /\btalent\b/i, /\bpeople ops\b/i, /\bhuman resources\b/i,
  /\bmarketing\b/i, /\bbrand\b/i, /\bcommunications\b/i, /\bcopywriter\b/i,
  /\bcounsel\b/i, /\blegal\b/i, /\bparalegal\b/i,
  /\bfinance\b/i, /\baccounting\b/i, /\bcontroller\b/i, /\bpayroll\b/i, /\btax\b/i,
  /\bproduct manager\b/i, /\bproduct owner\b/i, /\bprogram manager\b/i,
  /\b(ux|ui|graphic|visual) designer\b/i, /\bdesigner\b/i,
  /\bcustomer success\b/i, /\bcustomer solution\b/i, /\bcsm\b/i,
  /\bexecutive assistant\b/i, /\boffice manager\b/i, /\bfacilities\b/i,
  /\bteacher\b/i, /\binstructor\b/i, /\bcurriculum\b/i,
  /\bsales ops\b/i, /\brevenue ops\b/i, /\bbusiness development\b/i,
  /\bpartner manager\b/i, /\bcommunity\b/i, /\bevangelist\b/i, /\badvocate\b/i,
];

export type RoleFamily = "engineering" | "ambiguous" | "non-engineering";

/**
 * Decisive non-engineering markers. These win even when an engineering-ish word
 * also appears — "Associate General Counsel, Privacy Compliance" is a lawyer,
 * and "compliance" must not rescue it.
 */
const HARD_NON_ENGINEERING = [
  /\bcounsel\b/i, /\blegal\b/i, /\bparalegal\b/i, /\battorney\b/i,
  /\bsales\b(?!\s+engineer)/i, /\bsales ops\b/i, /\brevenue ops\b/i,
  /\baccount (executive|manager|director)\b/i, /\bbdr\b/i, /\bsdr\b/i,
  /\brecruit(er|ing)\b/i, /\btalent acquisition\b/i,
  /\bproduct manager\b/i, /\bproduct owner\b/i,
  /\bcustomer success\b/i, /\bcustomer solution\b/i,
  /\bmarketing\b/i, /\bpayroll\b/i, /\bexecutive assistant\b/i,
];

export function classifyRole(title: string): { family: RoleFamily; fit: number; reason: string } {
  const hardNo = HARD_NON_ENGINEERING.find((re) => re.test(title));
  if (hardNo) {
    return {
      family: "non-engineering",
      fit: 0,
      reason: `title matches decisive non-engineering pattern ${hardNo}`,
    };
  }

  const isEng = ENGINEERING_TITLE.find((re) => re.test(title));
  const isNon = NON_ENGINEERING_TITLE.find((re) => re.test(title));

  // A non-engineering marker wins unless the title is also explicitly an
  // engineering title ("Security Analyst" survives; "Sales Ops Analyst" does not).
  if (isNon && !isEng) {
    return {
      family: "non-engineering",
      fit: 0,
      reason: `title matches non-engineering pattern ${isNon}`,
    };
  }
  if (isNon && isEng) {
    return {
      family: "ambiguous",
      fit: 0.5,
      reason: `title mixes engineering (${isEng}) and non-engineering (${isNon}) signals`,
    };
  }
  if (isEng) {
    return { family: "engineering", fit: 1, reason: `title matches ${isEng}` };
  }
  return {
    family: "ambiguous",
    fit: 0.4,
    reason: "title carries no clear engineering signal",
  };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ");
}

function hasTerm(haystack: string, term: string): boolean {
  const re = new RegExp(
    `(?:^|[^a-z0-9+#.])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^a-z0-9+#-]|$)`,
    "i",
  );
  return re.test(haystack);
}

/** Rank every angle against the posting; highest is the suggestion. */
export function suggestAngle(job: NormalizedJob): {
  best: Angle | null;
  scores: { angle: string; score: number }[];
} {
  const title = normalize(job.title);
  const body = normalize(job.descriptionText).slice(0, 6000);

  const scores = ANGLES.map((angle) => {
    let s = 0;
    for (const hint of angle.titleHints) {
      // Weight by specificity: "security engineer" is a stronger signal than
      // "platform", so "Platform Security Engineer" resolves to devsecops
      // rather than devops. Without this the longer, more precise hint loses
      // a tie to a generic one.
      if (title.includes(hint)) s += 10 + hint.length * 0.8;
      else if (body.includes(hint)) s += 1.5;
    }
    for (const [domain, weight] of Object.entries(angle.domains)) {
      if (body.includes(domain)) s += weight * 2;
    }
    for (const alias of angle.aliases) {
      if (title.includes(alias)) s += 4;
    }
    return { angle: angle.id, score: Number(s.toFixed(2)) };
  }).sort((a, b) => b.score - a.score);

  const top = scores[0];
  return {
    best: top && top.score > 0 ? (resolveAngle(top.angle) ?? null) : null,
    scores,
  };
}

export function scoreJob(
  corpus: Corpus,
  job: NormalizedJob,
  angleInput?: string | null,
): JobScore {
  const text = normalize(`${job.title}\n${job.descriptionText}`);

  const { best, scores: angleScores } = suggestAngle(job);
  const angle = resolveAngle(angleInput ?? null) ?? best;

  // Candidate requirement vocabulary: corpus skills + the extra list.
  const vocab = new Set<string>(EXTRA_TERMS);
  for (const s of corpus.skillLevels.keys()) vocab.add(s);
  for (const c of corpus.claims) for (const s of c.skills) vocab.add(normalize(s));

  // Only terms the posting actually mentions count as requirements.
  const required = [...vocab].filter((t) => t.length > 1 && hasTerm(text, t));

  const projected = project(corpus, angle?.id ?? null).claims;

  const matches: RequirementMatch[] = required.map((term) => {
    const viaClaims: string[] = [];
    for (const p of projected) {
      const haystack = normalize(
        `${p.claim.claim} ${p.claim.source} ${p.claim.skills.join(" ")} ${p.claim.domains.join(" ")}`,
      );
      if (hasTerm(haystack, term)) viaClaims.push(p.claim.id);
      if (viaClaims.length >= 3) break;
    }
    const level = corpus.skillLevels.get(term) ?? null;
    const matched = viaClaims.length > 0 || level !== null;
    return {
      term,
      matched,
      viaClaims,
      viaSkillLevel: level,
      weight: CRITICAL_TERMS.has(term) ? 2 : 1,
    };
  });

  const totalWeight = matches.reduce((a, m) => a + m.weight, 0);
  const gotWeight = matches.reduce((a, m) => a + (m.matched ? m.weight : 0), 0);
  const coverage = totalWeight === 0 ? 0 : gotWeight / totalWeight;

  // ── Role family gate ─────────────────────────────────────────────────
  const role = classifyRole(job.title);

  // ── Vocabulary-depth penalty ─────────────────────────────────────────
  // Coverage over a thin technical vocabulary is not evidence of fit. A JD
  // naming three detectable terms that all happen to match is a 100% coverage
  // score carrying almost no signal, so scale confidence by how technical the
  // posting actually is.
  const criticalPresent = matches.filter((m) => CRITICAL_TERMS.has(m.term)).length;
  const depth = Math.min(1, required.length / 12) * 0.6 + Math.min(1, criticalPresent / 4) * 0.4;

  const score = Math.round(coverage * role.fit * depth * 100);

  return {
    score,
    coverage: Math.round(coverage * 100),
    roleFamily: role.family,
    roleFit: role.fit,
    roleReason: role.reason,
    depth: Number(depth.toFixed(2)),
    criticalPresent,
    matches: matches.sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term)),
    matchedCount: matches.filter((m) => m.matched).length,
    totalCount: matches.length,
    suggestedAngle: best?.id ?? null,
    angleScores: angleScores.slice(0, 5),
    gaps: matches.filter((m) => !m.matched).map((m) => m.term),
  };
}
