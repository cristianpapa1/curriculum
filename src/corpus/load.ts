/**
 * Corpus loader + validator.
 *
 * Validation is deliberately strict and fails loudly. A corpus that silently
 * loads a claim with no `source` would defeat the anti-fabrication gate, so a
 * missing or empty `source` is a hard error, not a warning.
 */

import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Claim,
  Corpus,
  Profile,
  SkillLevel,
} from "./types.ts";
import { CorpusError } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Project root, resolved relative to this file — never hardcoded. */
export const PROJECT_ROOT = join(HERE, "..", "..");
/**
 * The corpus in use. `CORPUS_DIR` points elsewhere — the tests use the fictional
 * example corpus, so they never depend on a real candidate's data.
 */
export const CORPUS_DIR = process.env.CORPUS_DIR ? resolve(process.env.CORPUS_DIR) : join(PROJECT_ROOT, "Corpus");

const SKILL_LEVELS: SkillLevel[] = [
  "expert",
  "proficient",
  "intermediate",
  "familiar",
];

async function readYaml<T>(path: string): Promise<T> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new CorpusError(`corpus file not found: ${path}`);
  }
  const text = await file.text();
  try {
    return Bun.YAML.parse(text) as T;
  } catch (err) {
    throw new CorpusError(
      `failed to parse YAML at ${path}: ${(err as Error).message}`,
    );
  }
}

function validateProfile(profile: Profile, path: string): void {
  const required = [
    "identity",
    "eligibility",
    "languages",
    "education",
    "certifications",
    "skills",
    "gaps",
  ] as const;
  for (const key of required) {
    if (!profile?.[key]) {
      throw new CorpusError(`${path}: missing required section "${key}"`);
    }
  }
  if (!profile.identity.name || !profile.identity.email) {
    throw new CorpusError(`${path}: identity.name and identity.email are required`);
  }
  for (const level of SKILL_LEVELS) {
    if (!Array.isArray(profile.skills[level])) {
      throw new CorpusError(`${path}: skills.${level} must be a list`);
    }
  }
  // Bun.YAML coerces an unquoted `2023-05` to the NUMBER 2023, silently
  // dropping the month — which would put wrong dates on every CV. Demand the
  // quoted YYYY-MM string form so the corruption cannot come back unnoticed.
  for (const e of profile.employment ?? []) {
    for (const field of ["start", "end"] as const) {
      const v = e[field];
      if (field === "end" && (v === null || v === undefined)) continue;
      if (typeof v !== "string" || !/^\d{4}-\d{2}$/.test(v)) {
        throw new CorpusError(
          `${path}: employment "${e.id}" has ${field}=${JSON.stringify(v)} — ` +
            `must be a QUOTED "YYYY-MM" string (unquoted YAML dates lose the month)`,
        );
      }
    }
  }

  if (profile.gaps.length < 1) {
    throw new CorpusError(
      `${path}: at least one declared gap is required — gaps stop the ` +
        `renderer from over-claiming`,
    );
  }
}

function validateClaims(claims: Claim[], path: string): void {
  if (!Array.isArray(claims) || claims.length === 0) {
    throw new CorpusError(`${path}: claims must be a non-empty list`);
  }
  const seen = new Set<string>();
  for (const [i, c] of claims.entries()) {
    const at = `${path}: claim[${i}]${c?.id ? ` (${c.id})` : ""}`;
    if (!c?.id) throw new CorpusError(`${at}: missing "id"`);
    if (seen.has(c.id)) throw new CorpusError(`${at}: duplicate id "${c.id}"`);
    seen.add(c.id);

    if (!c.claim?.trim()) throw new CorpusError(`${at}: missing "claim" text`);
    // The contract that makes anti-fabrication mechanical.
    if (!c.source?.trim()) {
      throw new CorpusError(
        `${at}: missing "source" — every claim must quote the original CV so ` +
          `the anti-fabrication gate can verify it`,
      );
    }
    if (!Array.isArray(c.domains) || c.domains.length === 0) {
      throw new CorpusError(`${at}: "domains" must be a non-empty list`);
    }
    if (typeof c.strength !== "number" || c.strength < 1 || c.strength > 5) {
      throw new CorpusError(`${at}: "strength" must be a number 1-5`);
    }
    if (!Array.isArray(c.skills)) {
      throw new CorpusError(`${at}: "skills" must be a list (may be empty)`);
    }
  }
}

export async function loadCorpus(dir: string = CORPUS_DIR): Promise<Corpus> {
  const profilePath = join(dir, "profile.yaml");
  const claimsPath = join(dir, "claims.yaml");

  const profile = await readYaml<Profile>(profilePath);
  const claimsDoc = await readYaml<{ claims: Claim[] }>(claimsPath);
  const claims = claimsDoc?.claims;

  validateProfile(profile, profilePath);
  validateClaims(claims, claimsPath);

  const skillLevels = new Map<string, SkillLevel>();
  for (const level of SKILL_LEVELS) {
    for (const skill of profile.skills[level]) {
      skillLevels.set(skill.toLowerCase(), level);
    }
  }

  const byId = new Map(claims.map((c) => [c.id, c]));

  // i18n is optional — an absent file just means English-only rendering.
  const translations = new Map<string, Partial<Record<"pt" | "es", string>>>();
  const i18nFile = Bun.file(join(dir, "i18n.yaml"));
  if (await i18nFile.exists()) {
    const doc = Bun.YAML.parse(await i18nFile.text()) as {
      translations?: Record<string, { pt?: string; es?: string }>;
    };
    for (const [id, t] of Object.entries(doc?.translations ?? {})) {
      // A translation keyed to a claim that no longer exists is a silent
      // correctness hole — fail loudly instead.
      if (!byId.has(id)) {
        throw new CorpusError(`i18n.yaml: translation for unknown claim id "${id}"`);
      }
      translations.set(id, {
        ...(t.pt?.trim() ? { pt: t.pt.trim() } : {}),
        ...(t.es?.trim() ? { es: t.es.trim() } : {}),
      });
    }
  }

  return { profile, claims, skillLevels, byId, translations };
}

// `bun run src/corpus/load.ts` — smoke check (ISC-4).
if (import.meta.main) {
  const corpus = await loadCorpus();
  const domains = new Set(corpus.claims.flatMap((c) => c.domains));
  console.log(`corpus loaded: ${corpus.claims.length} claims`);
  console.log(`profile: ${corpus.profile.identity.name} — ${corpus.profile.identity.location}`);
  console.log(`distinct domains: ${domains.size}`);
  console.log(`declared skills: ${corpus.skillLevels.size}`);
  console.log(`declared gaps: ${corpus.profile.gaps.length}`);
  const pt = [...corpus.translations.values()].filter((t) => t.pt).length;
  const es = [...corpus.translations.values()].filter((t) => t.es).length;
  console.log(`translations: pt=${pt} es=${es} of ${corpus.claims.length} claims`);
}
