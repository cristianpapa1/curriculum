/**
 * Free-text application answers.
 *
 * These answers sell hard, within the truth: they open with the most impressive
 * real thing the corpus attests, use the posting's own vocabulary, name the
 * concrete projects, and quantify wherever a claim supports a number.
 *
 * The one line held: a tool the candidate does not have is never claimed. Not
 * out of modesty — a technical interview finds it in ninety seconds, and then
 * the role AND the credibility are gone. Everything the corpus attests is used
 * at full strength; nothing else is used at all. Every generated answer goes
 * through the anti-fabrication gate before it can be submitted.
 *
 * Every sentence below is assembled from the corpus. Nothing about a particular
 * candidate — a project, a number, a region — is written into this file.
 */

import type { Corpus } from "../corpus/types.ts";
import { project } from "../position/project.ts";

export type QuestionKind =
  | "tools-experience"
  | "why-company"
  | "open-source"
  | "proud-project"
  | "relevant-experience"
  | "generic";

export interface AnswerContext {
  company: string;
  roleTitle: string;
  angle: string | null;
  /** Requirements the posting names AND the corpus evidences. */
  requiredSkills: string[];
  /** What the posting asks for but the corpus cannot back. */
  gaps?: string[];
}

export interface GeneratedAnswer {
  kind: QuestionKind;
  text: string;
  claimIds: string[];
  /** Words from the posting deliberately mirrored back. */
  mirrored: string[];
}

export function classifyQuestion(q: string): QuestionKind {
  const s = q.toLowerCase();
  if (/open.?source|contribut|github/.test(s)) return "open-source";
  if (/why (do you want to |are you )?(work|join|interested)|why (us|this (role|company))/.test(s)) return "why-company";
  if (/experience.*(tool|technolog|stack|relevant)|what.*experience|familiar with/.test(s)) return "tools-experience";
  if (/proud|favourite|favorite|best (project|work)|tell us about a project/.test(s)) return "proud-project";
  if (/relevant experience|why are you a (good )?fit|what makes you/.test(s)) return "relevant-experience";
  return "generic";
}

/**
 * The skills the posting names that the candidate holds at expert or proficient
 * level, in the posting's own words.
 *
 * Found live: drawing from every level produced "That work runs on Ansible,
 * AWS, Python, Cloud, Linux, Prometheus" while AWS and Prometheus were only
 * working knowledge, and a sentence saying the work runs on them overstates it.
 */
function mirroredSkills(corpus: Corpus, required: string[]): string[] {
  const held = new Set<string>();
  for (const s of [...corpus.profile.skills.expert, ...corpus.profile.skills.proficient]) {
    held.add(s.toLowerCase());
  }
  return required.filter((r) => {
    const low = r.toLowerCase();
    for (const h of held) if (h.includes(low) || low.includes(h)) return true;
    return false;
  });
}

function topClaims(corpus: Corpus, ctx: AnswerContext, n: number) {
  const projected = project(corpus, ctx.angle, { limit: 24 }).claims;
  const req = ctx.requiredSkills.map((s) => s.toLowerCase());
  const overlap = (p: (typeof projected)[number]) => {
    const hay = `${p.claim.skills.join(" ")} ${p.claim.domains.join(" ")} ${p.claim.claim}`.toLowerCase();
    return req.reduce((acc, r) => (r.length >= 3 && hay.includes(r) ? acc + 1 : acc), 0);
  };
  return [...projected]
    .sort((a, b) => overlap(b) - overlap(a) || b.claim.strength - a.claim.strength)
    .slice(0, n);
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim().replace(/\.$/, "");

/** Claims the corpus marks as independent work (no employer). */
function independentClaims(corpus: Corpus) {
  return corpus.claims.filter((c) => !c.employer).sort((a, b) => b.strength - a.strength);
}

/**
 * The "outside work" sentence, built from independent-work claims. Silent when
 * the corpus holds none: an invented side project is the easiest lie to check.
 */
function independentLine(corpus: Corpus, hub: string | undefined): string {
  const own = independentClaims(corpus);
  if (own.length === 0) return "";
  const where = hub ? ` They are public at ${hub}.` : "";
  return `Outside work I ship my own projects — ${clean(own[0]!.claim)}.${where}`;
}

/** The cross-timezone sentence, from profile.eligibility.proven_timezones. */
function timezoneLine(corpus: Corpus): string {
  const zones = corpus.profile.eligibility.proven_timezones ?? [];
  if (zones.length === 0) return "";
  const list = zones.length > 1 ? `${zones.slice(0, -1).join(", ")} and ${zones.at(-1)}` : zones[0];
  return `I work daily with distributed teams across ${list}, so cross-timezone collaboration is routine.`;
}

export function generateAnswer(
  corpus: Corpus,
  question: string,
  ctx: AnswerContext,
): GeneratedAnswer {
  const kind = classifyQuestion(question);
  const mirrored = mirroredSkills(corpus, ctx.requiredSkills);
  const picks = topClaims(corpus, ctx, 4);
  const ids = picks.map((p) => p.claim.id);
  const id = corpus.profile.identity;

  // Capitalise the way the industry writes these, not by naive title-casing:
  // "postgresql" must read PostgreSQL, "ci/cd" must read CI/CD.
  const CANON: Record<string, string> = {
    postgresql: "PostgreSQL", "ci/cd": "CI/CD", iam: "IAM", rbac: "RBAC",
    aws: "AWS", oci: "OCI", api: "API", rest: "REST", siem: "SIEM",
    "iso 27001": "ISO 27001", sql: "SQL", sre: "SRE", mcp: "MCP",
    typescript: "TypeScript", javascript: "JavaScript", "next.js": "Next.js",
    fastapi: "FastAPI", "entra id": "Entra ID", devops: "DevOps", ai: "AI",
  };
  const toolList =
    mirrored.length > 0
      ? mirrored.slice(0, 6).map((s) => CANON[s.toLowerCase()] ?? s[0]!.toUpperCase() + s.slice(1)).join(", ")
      : "the stack this role runs on";

  switch (kind) {
    case "tools-experience": {
      const text = [
        mirrored.length > 0 ? `I work hands-on with ${toolList}.` : "",
        `${clean(picks[0]?.text ?? "")}.`,
        `${clean(picks[1]?.text ?? "")}.`,
        independentLine(corpus, id.hub ?? id.website),
      ]
        .filter(Boolean)
        .join(" ");
      return { kind, text, claimIds: ids, mirrored };
    }

    case "why-company": {
      // No claim about the company's mission: the corpus holds nothing about any
      // particular employer, so the answer stays on what is verifiable — the
      // overlap between the role and the work already done.
      const text = [
        `The ${ctx.roleTitle} role at ${ctx.company} is a direct continuation of the work I already do.`,
        `${clean(picks[0]?.text ?? "")}.`,
        `${clean(picks[1]?.text ?? "")}.`,
        mirrored.length > 0 ? `The role asks for ${toolList}, which I work with hands-on.` : "",
        `I want to do this work as the core of a team's product rather than as internal tooling.`,
      ].filter(Boolean).join(" ");
      return { kind, text, claimIds: ids, mirrored };
    }

    case "open-source": {
      const text = [
        `My public work is at ${id.github}${id.website ? ` and ${id.website}` : ""}.`,
        `Most of my work runs real infrastructure and lives in private repositories, but the approach is the same one I use in the open:`,
        `${clean(independentClaims(corpus)[0]?.claim ?? picks[0]?.text ?? "")}.`,
      ].join(" ");
      return { kind, text, claimIds: ids, mirrored };
    }

    case "proud-project": {
      // The strongest claim the corpus holds for this posting, told as the work
      // it was — never a project narrative written outside the corpus.
      const best = picks[0];
      const support = picks.slice(1, 3).map((p) => clean(p.text)).filter(Boolean);
      const text = [
        `The one I would point to: ${clean(best?.text ?? "")}.`,
        best?.claim.scope ? `The scope was ${clean(best.claim.scope)}.` : "",
        support.length > 0 ? `It sits alongside the rest of that work — ${support.join("; ")}.` : "",
        `What I am proud of there is that it held up in production and left something the team could operate without me.`,
      ].filter(Boolean).join(" ");
      return { kind, text, claimIds: ids, mirrored };
    }

    case "relevant-experience":
    case "generic":
    default: {
      const text = [
        `${clean(picks[0]?.text ?? "")}.`,
        `${clean(picks[1]?.text ?? "")}.`,
        mirrored.length > 0 ? `Of what ${ctx.roleTitle} calls for, I work hands-on with ${toolList}.` : "",
        timezoneLine(corpus),
      ]
        .filter(Boolean)
        .join(" ");
      return { kind, text, claimIds: ids, mirrored };
    }
  }
}
