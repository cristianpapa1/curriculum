/**
 * The projection engine.
 *
 * Takes the corpus plus a requested angle and returns claims ranked for that
 * angle, each rendered in its angle-appropriate wording. This is the mechanism
 * behind "if I say IAM, adjust the CV for IAM; if I say DevOps, do that".
 *
 * Ranking combines three signals:
 *   1. domain weight   — how relevant the domain is to the requested angle
 *   2. centrality      — where that domain sits in the claim's OWN domains list
 *                        (domains[0] is what the claim is most about)
 *   3. strength        — how differentiating the claim is in a competitive pool
 */

import type { Claim, Corpus } from "../corpus/types.ts";
import type { Angle } from "./angles.ts";
import { resolveAngle } from "./angles.ts";

export interface ProjectedClaim {
  claim: Claim;
  /** The wording to actually render for this angle. */
  text: string;
  /** Which variant key supplied `text`, or "canonical". */
  variantUsed: string;
  score: number;
  /** Which of the angle's domains this claim matched, for explainability. */
  matchedDomains: string[];
}

export interface Projection {
  angle: Angle | null;
  angleInput: string | null;
  claims: ProjectedClaim[];
}

const DOMAIN_MULTIPLIER = 10;
const STRENGTH_MULTIPLIER = 2;

/** Earlier in the claim's own domains list = more central to that claim. */
function centrality(index: number): number {
  return 1 / (1 + index);
}

function scoreClaim(claim: Claim, angle: Angle): { score: number; matched: string[] } {
  let domainScore = 0;
  const matched: string[] = [];

  for (const [domain, weight] of Object.entries(angle.domains)) {
    const idx = claim.domains.indexOf(domain);
    if (idx === -1) continue;
    domainScore += weight * centrality(idx);
    matched.push(domain);
  }

  return {
    score: domainScore * DOMAIN_MULTIPLIER + claim.strength * STRENGTH_MULTIPLIER,
    matched,
  };
}

/**
 * Choose the wording for this angle: the first variant key the claim actually
 * defines, else the canonical claim text (ISC-11, ISC-12).
 */
export function selectText(
  claim: Claim,
  angle: Angle | null,
  opts: { lang?: "en" | "pt" | "es"; translations?: Map<string, Partial<Record<"pt" | "es", string>>> } = {},
): {
  text: string;
  variantUsed: string;
} {
  // Localized documents use the canonical translation: the angle still drives
  // selection and ordering, which is where most of the tailoring value lives.
  const lang = opts.lang ?? "en";
  if (lang !== "en") {
    const translated = opts.translations?.get(claim.id)?.[lang];
    if (translated) return { text: translated.trim(), variantUsed: `canonical:${lang}` };
    // No translation — caller is responsible for falling back to English
    // wholesale rather than emitting a mixed-language document.
    return { text: claim.claim.trim(), variantUsed: "canonical:MISSING-TRANSLATION" };
  }

  if (!angle || !claim.variants) {
    return { text: claim.claim.trim(), variantUsed: "canonical" };
  }
  for (const key of [angle.id, ...angle.variantKeys]) {
    const variant = claim.variants[key];
    if (variant?.trim()) return { text: variant.trim(), variantUsed: key };
  }
  return { text: claim.claim.trim(), variantUsed: "canonical" };
}

/** A posting requirement and the claims that evidence it (from scoreJob). */
export interface RequirementEvidence {
  term: string;
  matched: boolean;
  viaClaims: string[];
  weight: number;
}

const REQUIREMENT_MULTIPLIER = 8;

/**
 * Turn a posting's evidenced requirements into a per-claim bonus.
 *
 * The angle says what KIND of role this is; the posting says what THIS team
 * actually asks for. Ranking on the angle alone put the same bullets in front
 * of a payments team and a platform team. A claim that evidences three of the
 * posting's named requirements now outranks one that merely fits the family.
 */
export function requirementBoost(requirements: RequirementEvidence[] = []): Map<string, number> {
  const boost = new Map<string, number>();
  for (const r of requirements) {
    if (!r.matched) continue;
    for (const id of r.viaClaims) boost.set(id, (boost.get(id) ?? 0) + r.weight * REQUIREMENT_MULTIPLIER);
  }
  return boost;
}

/**
 * Project the corpus toward an angle. An unrecognised angle is not an error —
 * it falls back to global strength ordering (ISC-10).
 */
export function project(
  corpus: Corpus,
  angleInput: string | null,
  opts: {
    limit?: number;
    minScore?: number;
    lang?: "en" | "pt" | "es";
    /** Per-claim bonus from a specific posting — see `requirementBoost`. */
    claimBoost?: Map<string, number>;
  } = {},
): Projection {
  const angle = resolveAngle(angleInput);
  const textOpts = { lang: opts.lang ?? "en", translations: corpus.translations };

  let projected: ProjectedClaim[];

  if (!angle) {
    projected = corpus.claims
      .map((claim) => {
        const { text, variantUsed } = selectText(claim, null, textOpts);
        return {
          claim,
          text,
          variantUsed,
          score: claim.strength * STRENGTH_MULTIPLIER,
          matchedDomains: [],
        };
      });
  } else {
    projected = corpus.claims.map((claim) => {
      const { score, matched } = scoreClaim(claim, angle);
      const { text, variantUsed } = selectText(claim, angle, textOpts);
      return { claim, text, variantUsed, score, matchedDomains: matched };
    });
  }

  if (opts.claimBoost) {
    for (const p of projected) p.score += opts.claimBoost.get(p.claim.id) ?? 0;
  }

  // Deterministic: score desc, then id asc so output never reorders run to run.
  projected.sort((a, b) =>
    b.score - a.score || a.claim.id.localeCompare(b.claim.id),
  );

  if (opts.minScore !== undefined) {
    projected = projected.filter((p) => p.score >= opts.minScore!);
  }
  if (opts.limit !== undefined) {
    projected = projected.slice(0, opts.limit);
  }

  return { angle, angleInput: angleInput ?? null, claims: projected };
}

// `bun run src/position/project.ts <angle>` — inspect a projection.
if (import.meta.main) {
  const { loadCorpus } = await import("../corpus/load.ts");
  const corpus = await loadCorpus();
  const input = process.argv[2] ?? null;
  const result = project(corpus, input, { limit: 8 });

  console.log(
    `angle input: ${input ?? "(none)"} → resolved: ${result.angle?.label ?? "NONE (strength fallback)"}\n`,
  );
  for (const [i, p] of result.claims.entries()) {
    console.log(
      `${String(i + 1).padStart(2)}. [${p.score.toFixed(1)}] ${p.claim.id} (variant: ${p.variantUsed})`,
    );
    console.log(`    ${p.text.replace(/\s+/g, " ").slice(0, 150)}`);
  }
}
