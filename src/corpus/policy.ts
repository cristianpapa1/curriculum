/**
 * The candidate's standing policy, read once from the corpus.
 *
 * Eligibility, level targeting and salary answers are decisions only the
 * candidate can make — where they would work, at what level, for how much. They
 * live in `preferences.yaml` and `profile.yaml` (written by `bun run onboard`),
 * never in code. The modules that apply them are synchronous and called from
 * many places, so the policy is read synchronously and cached.
 *
 * Every field is optional. With no policy the pipeline makes no personal
 * assumption: any city, any level, no salary ceiling.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CORPUS_DIR } from "./load.ts";

/** How far up a field the candidate targets. */
export type LevelTarget = "any" | "junior" | "up_to_senior";
/** The candidate's own level in a field — what forms are told when they ask. */
export type OwnLevel = "junior" | "pleno" | "senior";
export type Field = "iam" | "security" | "fullstack" | "it" | "other";

export interface Policy {
  /** Can work anywhere in the EU/EEA without a visa (an EU citizenship). */
  euWorkRights: boolean;
  home: {
    /** Country of residence; place-bound roles there need no visa. */
    country: string | null;
    /** Cities (metro area) where place-bound work needs no move. Empty = any. */
    cities: string[];
  };
  relocation: {
    /** Other cities in the home country the candidate would move to. */
    withinCountry: string[];
  };
  /** Target level per field; a field left out is "any". */
  focusLevels: Partial<Record<Field, LevelTarget>>;
  /** Own level per field; a field left out falls back to `other`, then "junior". */
  ownLevels: Partial<Record<Field, OwnLevel>>;
  compensation: {
    /** Answer "negotiable"/blank where a form allows it, instead of a number. */
    preferAvoidance: boolean;
    /** Ceilings on the low anchor: region → level → amount (region's currency/period). */
    caps: Record<string, Record<string, number>>;
  };
  /**
   * Other names a company sends mail under, keyed by the name in the ledger
   * (e.g. a company renamed after the posting was written). Used only to match
   * a security-code email to the application that triggered it.
   */
  mailCompanyAliases: Record<string, string[]>;
}

const EMPTY: Policy = {
  euWorkRights: false,
  home: { country: null, cities: [] },
  relocation: { withinCountry: [] },
  focusLevels: {},
  ownLevels: {},
  compensation: { preferAvoidance: true, caps: {} },
  mailCompanyAliases: {},
};

function readYamlSync(path: string): any {
  if (!existsSync(path)) return null;
  try {
    return Bun.YAML.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const LEVEL_WORDS: Record<string, OwnLevel> = {
  junior: "junior", júnior: "junior", jr: "junior", entry: "junior",
  pleno: "pleno", mid: "pleno", "mid-level": "pleno", intermediate: "pleno",
  senior: "senior", sênior: "senior", sr: "senior",
};

const toOwnLevel = (v: unknown): OwnLevel | undefined =>
  typeof v === "string" ? LEVEL_WORDS[v.trim().toLowerCase()] : undefined;

let cached: { dir: string; policy: Policy } | null = null;

/** The policy for the corpus in use (CORPUS_DIR). */
export function loadPolicy(dir: string = CORPUS_DIR): Policy {
  if (cached?.dir === dir) return cached.policy;
  const prefs = readYamlSync(join(dir, "preferences.yaml")) ?? {};
  const profile = readYamlSync(join(dir, "profile.yaml")) ?? {};

  const own: Partial<Record<Field, OwnLevel>> = {};
  const declared = profile.self_assessed_seniority;
  if (declared && typeof declared === "object") {
    for (const [field, value] of Object.entries(declared)) {
      const level = toOwnLevel(value);
      if (level) own[field as Field] = level;
    }
  } else {
    const single = toOwnLevel(declared);
    if (single) own.other = single;
  }

  const EU = /^(austria|belgium|bulgaria|croatia|cyprus|czech|denmark|estonia|finland|france|germany|greece|hungary|ireland|italy|latvia|lithuania|luxembourg|malta|netherlands|poland|portugal|romania|slovakia|slovenia|spain|sweden|european union|eu|eea|european economic area)/i;
  const rights = [...(profile.eligibility?.citizenship ?? []), ...(profile.eligibility?.authorized_to_work ?? [])].map(String);

  const policy: Policy = {
    euWorkRights: rights.some((r) => EU.test(r.trim())),
    home: {
      country: prefs.home?.country ?? profile.eligibility?.country_of_residence ?? null,
      cities: prefs.home?.cities ?? [],
    },
    relocation: { withinCountry: prefs.relocation?.within_country ?? [] },
    focusLevels: prefs.targeting?.focus_levels ?? {},
    ownLevels: own,
    compensation: {
      preferAvoidance: prefs.compensation?.prefer_avoidance ?? EMPTY.compensation.preferAvoidance,
      caps: prefs.compensation?.caps ?? {},
    },
    mailCompanyAliases: prefs.mail?.company_aliases ?? {},
  };
  cached = { dir, policy };
  return policy;
}

/** Forget the cached policy — after onboarding rewrites it, and in tests. */
export function resetPolicyCache(): void {
  cached = null;
}
