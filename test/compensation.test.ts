/**
 * Salary-expectation tests.
 *
 * the candidate's instruction: answer low. The tests below pin two things — that the
 * default really is the low anchor, and that "low" stays relative to the
 * region AND the role type, so a junior support figure never lands on a staff
 * security req (which would read as a mismatch, not a bargain).
 */

import { describe, expect, test } from "bun:test";
import {
  answerSalary,
  classifyRegion,
  roleFactor,
  BANDS,
} from "../src/pipeline/compensation.ts";

describe("region classification", () => {
  test("maps locations to the right band", () => {
    expect(classifyRegion("São Paulo, Brazil")).toBe("brazil");
    expect(classifyRegion("Helsinki, Finland")).toBe("nordics-eur");
    expect(classifyRegion("Stockholm, Sweden")).toBe("nordics-eur");
    expect(classifyRegion("Berlin, Germany")).toBe("europe-eur");
    expect(classifyRegion("Remote - US")).toBe("us-remote-usd");
    expect(classifyRegion("Remote, LATAM")).toBe("latam-remote-usd");
  });

  test("an unknown location falls back rather than throwing", () => {
    expect(classifyRegion("Remote, Global")).toBe("unknown");
    expect(BANDS.unknown.currency).toBe("USD");
  });
});

describe("role factor", () => {
  test("seniority orders correctly", () => {
    const j = roleFactor("Junior Platform Engineer").mult;
    const m = roleFactor("Platform Engineer").mult;
    const s = roleFactor("Senior Platform Engineer").mult;
    const p = roleFactor("Staff Platform Engineer").mult;
    expect(j).toBeLessThan(m);
    expect(m).toBeLessThan(s);
    expect(s).toBeLessThan(p);
  });

  test("role family orders correctly", () => {
    expect(roleFactor("IT Support Analyst").familyMult)
      .toBeLessThan(roleFactor("Platform Engineer").familyMult);
    expect(roleFactor("Platform Engineer").familyMult)
      .toBeLessThan(roleFactor("Security Engineer").familyMult);
    expect(roleFactor("Security Engineer").familyMult)
      .toBeLessThan(roleFactor("Solutions Architect").familyMult);
  });

  test("Portuguese and Spanish titles are recognised", () => {
    expect(roleFactor("Engenheiro de Plataforma Sênior").family).toBe("platform");
    expect(roleFactor("Analista de Suporte de TI").family).toBe("support");
    expect(roleFactor("Engenheiro de Segurança").family).toBe("security");
    expect(roleFactor("Ingeniero de Infraestructura").family).toBe("platform");
    expect(roleFactor("Analista de Suporte Júnior").level).toBe("junior");
  });

  test("an unknown title is treated as mid/general, never zero", () => {
    const r = roleFactor("Widget Wrangler");
    expect(r.level).toBe("mid");
    expect(r.family).toBe("general");
    expect(r.mult).toBe(1);
  });

  test("the multiplier is clamped against absurd combinations", () => {
    for (const t of ["Principal Solutions Architect", "Intern IT Support Trainee"]) {
      const m = roleFactor(t).mult;
      expect(m).toBeGreaterThanOrEqual(0.3);
      expect(m).toBeLessThanOrEqual(2.2);
    }
  });
});

describe("the answer itself", () => {
  test("low is the default strategy", () => {
    const a = answerSalary("Remote, LATAM", "", { title: "Platform Engineer", numberRequired: true });
    expect(a.strategy).toBe("low");
  });

  test("a mandatory numeric field gets the low regional figure for that role", () => {
    const a = answerSalary("Remote, LATAM", "", {
      title: "Platform Engineer", numberRequired: true,
    });
    expect(a.numeric!).toBe(BANDS["latam-remote-usd"].low);
    expect(Number(a.value)).toBe(a.numeric!);
  });

  // The default answers with a number at the bottom of the band, not a range.
  test("an optional field still gets the low number by default", () => {
    const a = answerSalary("Remote, LATAM", "", { title: "Platform Engineer" });
    expect(a.numeric).toBeGreaterThan(0);
    expect(a.value).toBe(String(a.numeric));
  });

  test("a free-text field states the low figure, not 'negotiable' alone", () => {
    const a = answerSalary("Remote, LATAM", "", { title: "Platform Engineer", acceptsText: true });
    expect(a.numeric).toBeGreaterThan(0);
    expect(a.value).toContain(new Intl.NumberFormat("en-US").format(a.numeric!));
  });

  test("avoidance is still available when a caller asks for it", () => {
    expect(answerSalary("Remote, LATAM", "", { title: "Platform Engineer", preferAvoidance: true }).value).toBe("");
    expect(answerSalary("Remote, LATAM", "", { title: "Platform Engineer", acceptsText: true, preferAvoidance: true }).value.toLowerCase()).toContain("negotiable");
  });

  test("Brazil is capped by the configured ceilings: Pleno R$ 11,000, Sênior R$ 14,000", () => {
    expect(answerSalary("São Paulo, Brazil", "", { title: "Senior Security Engineer", numberRequired: true }).numeric).toBe(14000);
    expect(answerSalary("São Paulo, Brazil", "", { title: "Analista de Segurança da Informação Pleno", numberRequired: true }).numeric).toBe(11000);
    // A lower band is left alone: the cap is a ceiling, not a target.
    expect(answerSalary("São Paulo, Brazil", "", { title: "Analista de Suporte Júnior", numberRequired: true }).numeric).toBeLessThan(11000);
  });

  test("preferAvoidance off commits to the number even when optional", () => {
    const a = answerSalary("Remote, LATAM", "", {
      title: "Platform Engineer", preferAvoidance: false,
    });
    expect(a.numeric).toBeGreaterThan(0);
  });

  test("the figure scales with seniority on the same posting", () => {
    const junior = answerSalary("Helsinki, Finland", "", {
      title: "Junior Security Engineer", numberRequired: true,
    }).numeric!;
    const senior = answerSalary("Helsinki, Finland", "", {
      title: "Senior Security Engineer", numberRequired: true,
    }).numeric!;
    expect(junior).toBeLessThan(senior);
  });

  test("the figure scales with region for the same role", () => {
    const latam = answerSalary("Remote, LATAM", "", { title: "Platform Engineer", numberRequired: true });
    const us = answerSalary("Remote - US", "", { title: "Platform Engineer", numberRequired: true });
    expect(us.numeric!).toBeGreaterThan(latam.numeric!);
    expect(us.currency).toBe("USD");
  });

  test("Brazil is answered monthly in BRL, elsewhere annually", () => {
    const br = answerSalary("São Paulo, Brazil", "", { title: "Engenheiro de Plataforma", numberRequired: true });
    expect(br.currency).toBe("BRL");
    expect(br.period).toBe("month");

    const fi = answerSalary("Helsinki, Finland", "", { title: "Platform Engineer", numberRequired: true });
    expect(fi.currency).toBe("EUR");
    expect(fi.period).toBe("year");
  });

  test("free text follows the document language, reais written the Brazilian way", () => {
    const pt = answerSalary("São Paulo, Brazil", "", {
      title: "Engenheiro de Plataforma", acceptsText: true, lang: "pt",
    });
    expect(pt.value).toContain("A partir de R$ 11.000/mês");

    const es = answerSalary("Ciudad de México, Mexico", "", {
      title: "Ingeniero de Plataforma", acceptsText: true, lang: "es",
    });
    expect(es.value).toContain("Desde");
  });

  test("ANTI: a Brazilian monthly figure never lands on a USD posting", () => {
    // The failure this guards against: answering ~12,000 (BRL/month) on a US
    // req, which reads as uninformed rather than modest.
    const us = answerSalary("Remote - US", "", { title: "Platform Engineer", numberRequired: true });
    expect(us.numeric!).toBeGreaterThan(50_000);
    expect(us.currency).not.toBe("BRL");
  });

  test("every answer explains itself", () => {
    const a = answerSalary("Helsinki, Finland", "", {
      title: "Senior Security Engineer", numberRequired: true,
    });
    expect(a.reason.length).toBeGreaterThan(20);
    expect(a.role.level).toBe("senior");
    expect(a.role.family).toBe("security");
  });
});
