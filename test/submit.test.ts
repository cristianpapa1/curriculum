/**
 * Submission-bridge logic that can be tested without a browser.
 */

import { describe, expect, test } from "bun:test";
import { loadCorpus } from "../src/corpus/load.ts";
import { comboboxPlan, applyUrlFor } from "../src/pipeline/submit.ts";
import type { ApplicationMeta } from "../src/ledger/ledger.ts";

const corpus = await loadCorpus();
const meta = (over: Partial<ApplicationMeta> = {}) =>
  ({
    id: "greenhouse:1", atsType: "greenhouse", jobId: "8163929", company: "Datadog",
    roleTitle: "Engineer", url: "https://careers.datadoghq.com/detail/8163929/",
    locationRaw: "Dublin, Ireland; Paris, France", eligibilityPath: "relocation-europe",
    requiresSponsorship: false, ...over,
  }) as ApplicationMeta;

describe("comboboxPlan", () => {
  test("ANTI: source questions never plan a referral", () => {
    const p = comboboxPlan("How did you hear about this opportunity?*", { corpus, meta: meta() })!;
    expect(p.terms.some((t) => /referr/i.test(t))).toBe(false);
  });

  test("demographics decline", () => {
    const p = comboboxPlan("Voluntary Self-Identification of Gender*", { corpus, meta: meta() })!;
    expect(p.terms[0]).toMatch(/decline/i);
  });

  test("acknowledgements are accepted", () => {
    const p = comboboxPlan("I certify that the information provided is accurate", { corpus, meta: meta() })!;
    expect(p.terms).toContain("Yes");
  });

  test("EU role: authorized yes, sponsorship no", () => {
    const m = meta();
    expect(comboboxPlan("Are you legally authorised to work full-time in Ireland?", { corpus, meta: m })!.terms).toEqual(["Yes"]);
    expect(comboboxPlan("Will you require visa sponsorship?", { corpus, meta: m })!.terms).toEqual(["No"]);
  });

  test("US role needing sponsorship answers truthfully", () => {
    const m = meta({ eligibilityPath: "relocation-us", requiresSponsorship: true, locationRaw: "San Francisco" });
    expect(comboboxPlan("Will you require visa sponsorship?", { corpus, meta: m })!.terms).toEqual(["Yes"]);
    expect(comboboxPlan("Are you legally authorized to work in the US?", { corpus, meta: m })!.terms).toEqual(["No"]);
  });

  test("fluent languages come only from native/C1 declarations", () => {
    const p = comboboxPlan("Please select all the languages you speak fluently", { corpus, meta: meta() })!;
    expect(p.multi).toBe(true);
    expect(p.terms).toContain("English");
    expect(p.terms).toContain("Portuguese");
    expect(p.terms).not.toContain("Spanish"); // intermediate
    expect(p.terms).not.toContain("Italian"); // citizenship is not fluency
  });

  test("cities come from the role's own location", () => {
    const p = comboboxPlan("In what cities are you available to work?*", { corpus, meta: meta() })!;
    expect(p.terms).toEqual(["Dublin", "Paris"]);
  });

  test("country is country of residence", () => {
    expect(comboboxPlan("Country*", { corpus, meta: meta() })!.terms).toEqual(["Brazil"]);
  });

  test("an unknown question is not guessed", () => {
    expect(comboboxPlan("What is your notice period?", { corpus, meta: meta() })).toBeNull();
  });
});

describe("applyUrlFor", () => {
  test("Greenhouse routes to the bare embed form, bypassing company-site iframes", () => {
    expect(applyUrlFor(meta())).toBe("https://boards.greenhouse.io/embed/job_app?token=8163929");
  });

  test("Ashby routes to the /application page", () => {
    expect(
      applyUrlFor(meta({ atsType: "ashby", url: "https://jobs.ashbyhq.com/supabase/abc" })),
    ).toBe("https://jobs.ashbyhq.com/supabase/abc/application");
  });
});

describe("live submission only acts on approved applications", () => {
  test("REGRESSION: a live run never selects a merely prepared application", async () => {
    // A retry filtered on "prepared" picked up an application from a batch
    // prepared minutes earlier for the candidate's review. The source must show the
    // live filter is approval-only.
    const src = await Bun.file(`${import.meta.dir}/../src/pipeline/submit.ts`).text();
    expect(src).toMatch(/dryRun \? a\.status === "prepared" \|\| a\.status === "approved" : a\.status === "approved"/);
  });
});

import { yesNoRules, companyCooldown } from "../src/pipeline/submit.ts";
import { checkFit, detectPostingLanguage } from "../src/pipeline/fit.ts";

const rule = (rules: ReturnType<typeof yesNoRules>, q: string) => rules.find((r) => r.match.test(q));

describe("derived Yes/No answers", () => {
  test("REGRESSION: a US role needing sponsorship answers sponsorship YES", () => {
    // Found on Drata's form: the static table answered "No" for the US.
    const rules = yesNoRules(meta({ eligibilityPath: "relocation-us", requiresSponsorship: true }), corpus);
    expect(rule(rules, "Will you now or in the future require sponsorship to work within the United States?")!.answer).toBe("Yes");
    expect(rule(rules, "Are you legally authorized to work in the United States?")!.answer).toBe("No");
  });

  test("an EU role answers sponsorship NO and authorized YES", () => {
    const rules = yesNoRules(meta({ eligibilityPath: "relocation-europe", requiresSponsorship: false }), corpus);
    expect(rule(rules, "Will you require visa sponsorship?")!.answer).toBe("No");
    expect(rule(rules, "Are you legally authorised to work in Germany?")!.answer).toBe("Yes");
  });

  test("located in the United States answers from residence", () => {
    const rules = yesNoRules(meta({ eligibilityPath: "relocation-us", requiresSponsorship: true }), corpus);
    expect(rule(rules, "Are you located in the United States?")!.answer).toBe("No");
  });

  test("REGRESSION: criminal record is never answered on the candidate's behalf", () => {
    // The static table answered "No — stated by the candidate". He never stated it.
    const rules = yesNoRules(meta(), corpus);
    const r = rule(rules, "Have you ever been convicted of a crime?")!;
    expect(r.answer).toBeNull();
    expect(r.why).toMatch(/escalated/);
  });
});

describe("companyCooldown", () => {
  const now = Date.parse("2026-09-14T15:00:00Z");
  test("an attempt on the same company within 24h blocks", () => {
    const ledger = [{ id: "ashby:a", company: "Iceye", submittedAt: "2026-09-14T13:20:00Z", notes: [] }];
    expect(companyCooldown({ id: "ashby:b", company: "ICEYE" }, ledger, now)).toMatch(/24h cooldown/);
  });
  test("a refused attempt recorded in notes also counts", () => {
    const ledger = [{ id: "ashby:a", company: "Drata", submittedAt: null, notes: ["2026-09-14T13:22 submit NOT confirmed — form refused"] }];
    expect(companyCooldown({ id: "ashby:a", company: "Drata" }, ledger, now)).not.toBeNull();
  });
  test("older than 24h or another company does not block", () => {
    const ledger = [
      { id: "x", company: "Iceye", submittedAt: "2026-09-12T10:00:00Z", notes: [] },
      { id: "y", company: "Supabase", submittedAt: "2026-09-14T14:00:00Z", notes: [] },
    ];
    expect(companyCooldown({ id: "z", company: "Iceye" }, ledger, now)).toBeNull();
  });
});

describe("checkFit", () => {
  const job = (title: string, descriptionText = "We are looking for an engineer to join our team and you will work with the platform.") => ({ title, descriptionText });

  test("titles above the target level are rejected", () => {
    for (const t of ["Head of International Security", "Engineering Manager, Infrastructure", "Telco Field Engineering Director", "Staff Engineer (Client Ops)", "Engineering Site Lead", "Principal Solutions Architect"]) {
      expect(checkFit(corpus, job(t)).check).toBe("level");
    }
  });

  test("'Member of Technical Staff' is a flat title, not a level", () => {
    expect(checkFit(corpus, job("Member of Technical Staff (AI Infrastructure Engineer)")).ok).toBe(true);
  });

  test("senior titles are within range", () => {
    expect(checkFit(corpus, job("Senior Platform Security Engineer")).ok).toBe(true);
  });

  test("titles naming a language the profile lacks are rejected", () => {
    expect(checkFit(corpus, job("Senior Software Engineer - C Programmer")).check).toBe("title-tech");
    expect(checkFit(corpus, job("Intermediate Java Developer")).check).toBe("title-tech");
  });

  test("JavaScript is not mistaken for Java; held languages pass", () => {
    expect(checkFit(corpus, job("Senior JavaScript Engineer")).ok).toBe(true);
    expect(checkFit(corpus, job("Python Backend Engineer")).ok).toBe(true);
  });

  test("a posting written in French is rejected", () => {
    const fr = "Nous recherchons un architecte cloud pour rejoindre notre équipe. Vous serez responsable de la conception et de la mise en place des solutions avec nos clients dans le cadre des projets.";
    expect(detectPostingLanguage(fr).lang).toBe("fr");
    expect(checkFit(corpus, job("Architecte Cloud Azure F/H", fr)).check).toBe("posting-language");
  });

  test("an English posting in France passes", () => {
    expect(checkFit(corpus, job("Platform Engineer", "You will build the platform and work with our team on the infrastructure that our customers use.")).ok).toBe(true);
  });
});
