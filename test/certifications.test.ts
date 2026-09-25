/**
 * The `__CERTS__` variable: name the certifications that relate to the posting,
 * and say nothing about certifications when none do.
 */
import { describe, expect, test } from "bun:test";
import { loadCorpus } from "../src/corpus/load.ts";
import { relevantCertifications, certificationsText, postingSignals } from "../src/pipeline/certifications.ts";
import { renderCV } from "../src/render/cv.ts";
import { renderLetter, shortCertName } from "../src/render/letter.ts";

const corpus = await loadCorpus();
const names = (title: string, terms: string[]) => relevantCertifications(corpus, postingSignals(title, terms)).map((c) => c.name);

describe("which certifications relate to a posting", () => {
  test("a cloud security role gets the security certification first", () => {
    const got = names("Cloud Security Engineer", ["aws", "azure", "iam", "network security"]);
    expect(got[0]).toContain("Security - Specialty");
    expect(got.some((n) => /Identity and Access/.test(n))).toBe(true);
  });

  test("an observability role gets the observability certification, not the identity one", () => {
    const got = names("Site Reliability Engineer", ["prometheus", "monitoring", "observability"]);
    expect(got.some((n) => /Observability/.test(n))).toBe(true);
    expect(got.some((n) => /Identity and Access/.test(n))).toBe(false);
  });

  test("REGRESSION: a software role is judged on its requirements, not the company boilerplate", () => {
    // Matched on a full description instead, a back-end role related to every
    // certification on file.
    const got = names("Software Engineer, Payments", ["kubernetes", "terraform", "golang", "graphql", "grpc", "react", "platform", "automation"]);
    expect(got.some((n) => /Observability|Security|Identity and Access/.test(n))).toBe(false);
    expect(got.length).toBeLessThan(corpus.profile.certifications.length);
  });

  test("ANTI: a help-desk role with no related domain gets none", () => {
    expect(names("Analista de Suporte Júnior", ["office", "atendimento", "operações"])).toEqual([]);
    expect(certificationsText([])).toBe("");
  });
});

describe("documents mention certifications only when related", () => {
  const unrelated = postingSignals("Analista de Suporte Júnior", ["office", "atendimento"]);
  const related = postingSignals("Cloud Security Engineer", ["iam", "network security"]);

  test("the CV leaves the section out for an unrelated posting", () => {
    const cv = renderCV(corpus, null, { postingSignals: unrelated });
    expect(cv.markdown).not.toContain("## Certifications");
    expect(cv.markdown).not.toContain("Certified");
  });

  test("the CV lists only related certifications", () => {
    const cv = renderCV(corpus, null, { postingSignals: related });
    expect(cv.markdown).toContain("Security - Specialty");
    expect(cv.markdown).not.toContain("Observability Engineer");
  });

  test("the letter names related certifications and is silent otherwise", () => {
    const base = { company: "Acme", roleTitle: "Cloud Security Engineer" };
    expect(renderLetter(corpus, null, { ...base, postingSignals: related }).markdown).toContain("AWS Security - Specialty");
    // A claim may legitimately say "certification"; what must be absent is the
    // sentence naming certifications this candidate holds.
    const silent = renderLetter(corpus, null, { ...base, postingSignals: unrelated }).markdown;
    expect(silent).not.toMatch(/hold certifications/i);
    expect(silent).not.toContain("Specialty");
  });

  test("short names drop the year and the word Certified", () => {
    expect(shortCertName("AWS Certified Security - Specialty")).toBe("AWS Security - Specialty");
    expect(shortCertName("Amazon Web Services 2025 Certified Security Specialty")).toBe("AWS Security Specialty");
    expect(shortCertName("Oracle Cloud Infrastructure 2025 Certified Foundations Associate")).toBe("OCI Foundations Associate");
  });
});
