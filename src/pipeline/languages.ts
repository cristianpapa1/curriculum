/**
 * Language-requirement gate.
 *
 * Found live: the pipeline prepared an application for a "Technical Enablement
 * Manager (<language> Speaking)" role because the candidate holds that
 * country's CITIZENSHIP, which is why the role surfaced — but citizenship is
 * not fluency, and the profile never claimed the language. Applying would have
 * been wasted at best and, at worst, read as posing as a speaker.
 *
 * So a posting that names a spoken language in its title or requirements is
 * checked against the declared languages in `profile.yaml`. A language the
 * candidate does not have at the required level blocks that application; nothing else is
 * affected.
 *
 * Deliberately conservative: only an EXPLICIT requirement blocks. A job merely
 * located in Germany does not demand German — many EU tech roles run in English,
 * and inferring otherwise would throw away the whole point of EU eligibility.
 */

import type { Corpus } from "../corpus/types.ts";

export interface LanguageRequirement {
  language: string;
  /** Where the requirement was found. */
  evidence: string;
  /** Title requirements are hard; body mentions are softer. */
  source: "title" | "body";
  /** Roughly how fluent the posting expects. */
  level: "native" | "fluent" | "professional";
}

export interface LanguageVerdict {
  ok: boolean;
  required: LanguageRequirement[];
  missing: LanguageRequirement[];
  reason: string;
}

/** Languages a posting might demand, with the ways they get written. */
const LANGUAGES: { name: string; patterns: string[] }[] = [
  { name: "Italian", patterns: ["italian", "italiano"] },
  { name: "German", patterns: ["german", "deutsch", "dach"] },
  { name: "French", patterns: ["french", "français", "francais"] },
  { name: "Spanish", patterns: ["spanish", "español", "espanol", "castellano"] },
  { name: "Portuguese", patterns: ["portuguese", "português", "portugues"] },
  { name: "Dutch", patterns: ["dutch", "nederlands"] },
  { name: "Swedish", patterns: ["swedish", "svenska"] },
  { name: "Finnish", patterns: ["finnish", "suomi"] },
  { name: "Danish", patterns: ["danish", "dansk"] },
  { name: "Norwegian", patterns: ["norwegian", "norsk"] },
  { name: "Polish", patterns: ["polish", "polski"] },
  { name: "Japanese", patterns: ["japanese"] },
  { name: "Mandarin", patterns: ["mandarin", "chinese"] },
  { name: "Arabic", patterns: ["arabic"] },
  { name: "Hebrew", patterns: ["hebrew"] },
];

/** Levels the candidate's declared proficiency must reach to satisfy a requirement. */
const LEVEL_RANK: Record<string, number> = {
  native: 4, c2: 4, fluent: 3, c1: 3, advanced: 3,
  professional: 2, b2: 2, intermediate: 2, b1: 1, basic: 1, a2: 1, a1: 1,
};

function declaredRank(level: string): number {
  return LEVEL_RANK[level.trim().toLowerCase()] ?? 0;
}

function requiredRank(level: LanguageRequirement["level"]): number {
  return level === "native" ? 4 : level === "fluent" ? 3 : 2;
}

/** Extract explicit spoken-language requirements from a posting. */
export function detectLanguageRequirements(
  title: string,
  descriptionText: string,
): LanguageRequirement[] {
  const out: LanguageRequirement[] = [];
  const body = descriptionText.slice(0, 6000);

  for (const lang of LANGUAGES) {
    for (const p of lang.patterns) {
      // Title forms: "(Italian Speaking)", "German-speaking", "DACH"
      const titleRe = new RegExp(`\\b${p}[\\s-]*(speaking|speaker)?\\b`, "i");
      if (titleRe.test(title)) {
        out.push({
          language: lang.name,
          evidence: title.match(titleRe)?.[0]?.trim() ?? p,
          source: "title",
          level: "fluent",
        });
        break;
      }

      // Body forms: an explicit requirement, not a passing mention.
      const bodyRe = new RegExp(
        `\\b(native|fluent|fluency in|professional (?:working )?proficiency in|must speak|required?:?\\s*)\\s*${p}\\b` +
          `|\\b${p}\\s*(?:language)?\\s*(?:is\\s*)?(?:required|mandatory|essential|a must)\\b`,
        "i",
      );
      const m = body.match(bodyRe);
      if (m) {
        const hit = m[0].toLowerCase();
        out.push({
          language: lang.name,
          evidence: m[0].trim(),
          source: "body",
          level: hit.includes("native") ? "native" : hit.includes("fluen") ? "fluent" : "professional",
        });
        break;
      }
    }
  }

  return out;
}

export function checkLanguages(
  corpus: Corpus,
  title: string,
  descriptionText: string,
): LanguageVerdict {
  const required = detectLanguageRequirements(title, descriptionText);

  if (required.length === 0) {
    return { ok: true, required: [], missing: [], reason: "no explicit language requirement" };
  }

  const declared = new Map(
    corpus.profile.languages.map((l) => [l.language.toLowerCase(), declaredRank(l.level)]),
  );

  const missing = required.filter((r) => {
    const have = declared.get(r.language.toLowerCase()) ?? 0;
    return have < requiredRank(r.level);
  });

  if (missing.length === 0) {
    return {
      ok: true,
      required,
      missing: [],
      reason: `requires ${required.map((r) => r.language).join(", ")} — all declared at sufficient level`,
    };
  }

  return {
    ok: false,
    required,
    missing,
    reason:
      `posting requires ${missing.map((r) => `${r.language} (${r.level}, from ${r.source}: "${r.evidence}")`).join("; ")} ` +
      `— not declared in profile.yaml (has: ${corpus.profile.languages.map((l) => `${l.language} ${l.level}`).join(", ")})`,
  };
}
