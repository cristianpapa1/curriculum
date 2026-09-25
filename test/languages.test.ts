/**
 * Language-requirement gate.
 *
 * Found live: the pipeline prepared an application for a "Technical Enablement
 * Manager (Polish Speaking)" role because the candidate holds Polish
 * citizenship. Citizenship is not fluency — the persona does not speak Polish
 * and the profile never claimed otherwise.
 */

import { describe, expect, test } from "bun:test";
import { loadCorpus } from "../src/corpus/load.ts";
import { checkLanguages, detectLanguageRequirements } from "../src/pipeline/languages.ts";

const corpus = await loadCorpus();

describe("detecting requirements", () => {
  test("title forms are caught", () => {
    expect(detectLanguageRequirements("Manager (Polish Speaking)", "")[0]!.language).toBe("Polish");
    expect(detectLanguageRequirements("AE, DACH (German-speaking)", "")[0]!.language).toBe("German");
    expect(detectLanguageRequirements("Support, French Speaker", "")[0]!.language).toBe("French");
  });

  test("explicit body requirements are caught", () => {
    const r = detectLanguageRequirements("Engineer", "Fluent German is required.");
    expect(r[0]!.language).toBe("German");
    expect(r[0]!.source).toBe("body");
  });

  test("a passing mention is NOT a requirement", () => {
    // Being located in Germany does not demand German — most EU tech roles run
    // in English, and inferring otherwise throws away EU eligibility entirely.
    expect(detectLanguageRequirements("Platform Engineer", "Our office is in Germany, Berlin.")).toEqual([]);
    expect(detectLanguageRequirements("Cloud Engineer", "We are a Spanish company.")).toEqual([]);
  });
});

describe("the gate", () => {
  test("BLOCKS a language the candidate does not speak", () => {
    const v = checkLanguages(corpus, "Technical Enablement Manager (Polish Speaking)", "");
    expect(v.ok).toBe(false);
    expect(v.missing[0]!.language).toBe("Polish");
    expect(v.reason).toContain("Polish");
  });

  test("citizenship does not count as fluency", () => {
    // Polish citizenship is in profile.eligibility; Polish is NOT in
    // profile.languages. The gate must read the latter.
    expect(corpus.profile.eligibility.citizenship).toContain("Poland");
    expect(corpus.profile.languages.some((l) => l.language === "Polish")).toBe(false);
    expect(checkLanguages(corpus, "Role (Polish Speaking)", "").ok).toBe(false);
  });

  test("PASSES a language the profile declares at the required level", () => {
    expect(checkLanguages(corpus, "Engineer", "Native Portuguese speaker required.").ok).toBe(true);
    expect(checkLanguages(corpus, "Engineer", "Fluent English is required.").ok).toBe(true);
  });

  test("BLOCKS when his level is below what is demanded", () => {
    // Spanish is declared Intermediate; "fluent" outranks it.
    expect(checkLanguages(corpus, "Engineer", "Fluent Spanish is required.").ok).toBe(false);
  });

  test("PASSES when no language is demanded", () => {
    const v = checkLanguages(corpus, "Senior Platform Engineer", "Terraform, Docker, AWS.");
    expect(v.ok).toBe(true);
    expect(v.required).toEqual([]);
  });

  test("every verdict explains itself", () => {
    const v = checkLanguages(corpus, "Manager (German-speaking)", "");
    expect(v.reason).toContain("German");
    expect(v.reason).toContain("profile.yaml");
  });
});
