/**
 * Localization tests.
 *
 * Policy: Brazil → Portuguese, Spanish-speaking LATAM and Mexico → Spanish,
 * everything else → English. Plus the rule that a partially-translated document
 * falls back to English entirely rather than shipping mixed languages.
 */

import { describe, expect, test } from "bun:test";
import { loadCorpus } from "../src/corpus/load.ts";
import { renderCV } from "../src/render/cv.ts";
import { renderLetter } from "../src/render/letter.ts";
import { checkAntiFabrication } from "../src/position/antifab.ts";
import {
  chooseLocale,
  checkTranslationIntegrity,
  CHROME,
  CV_TITLES,
} from "../src/render/locale.ts";
import { ANGLES } from "../src/position/angles.ts";
import type { Corpus } from "../src/corpus/types.ts";

const corpus: Corpus = await loadCorpus();
const job = (locationRaw: string, descriptionText = "") => ({ locationRaw, descriptionText });

describe("locale selection", () => {
  test("Brazil resolves to Portuguese", () => {
    for (const loc of ["São Paulo, Brazil", "Brasil", "Remote - Brazil", "Rio de Janeiro"]) {
      expect(chooseLocale(job(loc)).lang).toBe("pt");
    }
  });

  test("Spanish-speaking LATAM and Mexico resolve to Spanish", () => {
    for (const loc of [
      "Ciudad de México, Mexico", "Buenos Aires, Argentina", "Bogotá, Colombia",
      "Santiago, Chile", "Lima, Peru", "Montevideo, Uruguay",
    ]) {
      expect(chooseLocale(job(loc)).lang).toBe("es");
    }
  });

  test("everything else stays English", () => {
    for (const loc of ["Remote, Global", "Berlin, Germany", "New York", "Remote - AMER", "Singapore"]) {
      expect(chooseLocale(job(loc)).lang).toBe("en");
    }
  });

  test("pan-regional LATAM stays English, not Spanish", () => {
    // A pan-LATAM req is posted and screened in English, and guessing Spanish
    // for a Brazilian applicant would be actively wrong.
    expect(chooseLocale(job("Remote, LATAM")).lang).toBe("en");
  });

  test("every decision carries a reason", () => {
    expect(chooseLocale(job("São Paulo, Brazil")).reason).toContain("Brazil");
    expect(chooseLocale(job("Remote, Global")).reason).toContain("defaulting to English");
  });
});

describe("translation coverage", () => {
  test("every claim has both pt and es", () => {
    const missing: string[] = [];
    for (const c of corpus.claims) {
      const t = corpus.translations.get(c.id);
      if (!t?.pt) missing.push(`${c.id}:pt`);
      if (!t?.es) missing.push(`${c.id}:es`);
    }
    expect(missing).toEqual([]);
  });

  test("every angle renders fully in pt and es without falling back", () => {
    for (const angle of ANGLES.map((a) => a.id)) {
      for (const lang of ["pt", "es"] as const) {
        const cv = renderCV(corpus, angle, { lang });
        expect(cv.lang).toBe(lang);
        expect(cv.langFallbackReason).toBeNull();
      }
    }
  });

  test("localized CVs use localized headings and titles", () => {
    const pt = renderCV(corpus, "iam", { lang: "pt" });
    expect(pt.markdown).toContain(CHROME.pt.summary);
    expect(pt.markdown).toContain(CHROME.pt.experience);
    expect(pt.markdown).toContain(CV_TITLES.pt.iam!);
    expect(pt.markdown).toContain("Atual");

    const es = renderCV(corpus, "devops", { lang: "es" });
    expect(es.markdown).toContain(CHROME.es.experience);
    expect(es.markdown).toContain(CV_TITLES.es.devops!);
  });

  test("localized letters use localized salutation and sign-off", () => {
    const pt = renderLetter(corpus, "iam", { company: "Banco Aurora", roleTitle: "Engenheiro de Plataforma", lang: "pt" });
    expect(pt.lang).toBe("pt");
    expect(pt.markdown).toContain("Prezado(a)");
    expect(pt.markdown).toContain("Atenciosamente,");
    expect(pt.markdown).toContain("Banco Aurora");

    const es = renderLetter(corpus, "cloud", { company: "Kavak", roleTitle: "Ingeniero de Nube", lang: "es" });
    expect(es.lang).toBe("es");
    expect(es.markdown).toContain("Estimado/a");
    expect(es.markdown).toContain("Atentamente,");
  });
});

describe("translation integrity", () => {
  test("numbers and technology names survive translation", () => {
    for (const angle of ["iam", "devops", "ai", "security"]) {
      const en = renderCV(corpus, angle, { lang: "en" });
      for (const lang of ["pt", "es"] as const) {
        const localized = renderCV(corpus, angle, { lang });
        const r = checkTranslationIntegrity(en.markdown, localized.markdown);
        if (!r.ok) console.error(`${angle}/${lang} lost:`, r.missing);
        expect(r.ok).toBe(true);
      }
    }
  });

  test("a translation that mangles a metric is caught", () => {
    const r = checkTranslationIntegrity(
      "Managed 250 endpoints with ISO 27001 controls.",
      "Gerenciou 250000 endpoints com controles de conformidade.",
    );
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("250");
  });

  test("localized documents still pass the anti-fabrication gate's number check", () => {
    // The gate's vocabulary is English, but its METRIC check is language-neutral,
    // so a localized CV must not introduce unattested numbers.
    for (const lang of ["pt", "es"] as const) {
      const cv = renderCV(corpus, "iam", { lang });
      const gate = checkAntiFabrication(cv.markdown, corpus);
      const metricViolations = gate.violations.filter((v) => v.kind === "metric");
      if (metricViolations.length) console.error(lang, metricViolations);
      expect(metricViolations).toEqual([]);
    }
  });
});
