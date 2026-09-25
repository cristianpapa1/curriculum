/**
 * Corpus, projection and anti-fabrication tests (ISC-1..17).
 * Network-free — these run against the real corpus on disk.
 */

import { describe, expect, test } from "bun:test";
import { loadCorpus, CORPUS_DIR } from "../src/corpus/load.ts";
import { project, selectText } from "../src/position/project.ts";
import { resolveAngle } from "../src/position/angles.ts";
import { checkAntiFabrication } from "../src/position/antifab.ts";
import type { Corpus } from "../src/corpus/types.ts";

const corpus: Corpus = await loadCorpus();
const topIds = (angle: string | null, n: number) =>
  project(corpus, angle, { limit: n }).claims.map((p) => p.claim.id);

describe("corpus (ISC-1..6)", () => {
  test("ISC-1: profile has all required sections", () => {
    const p = corpus.profile;
    expect(p.identity.name).toBe("Jordan Reis");
    expect(p.eligibility.citizenship).toEqual(["Brazil", "Poland"]);
    expect(p.eligibility.authorized_to_work).toContain("European Union");
    expect(p.eligibility.requires_sponsorship_for).not.toContain("EU");
    expect(p.languages.length).toBeGreaterThan(0);
    expect(p.education.length).toBeGreaterThan(0);
    expect(p.certifications.length).toBe(6);
    expect(p.skills.expert.length).toBeGreaterThan(0);
  });

  test("ISC-2: every claim has id, claim, domains and source", () => {
    for (const c of corpus.claims) {
      expect(c.id).toBeTruthy();
      expect(c.claim.trim().length).toBeGreaterThan(0);
      expect(c.domains.length).toBeGreaterThan(0);
      expect(c.source.trim().length).toBeGreaterThan(0);
    }
  });

  test("ISC-3: claim ids are unique", () => {
    const ids = corpus.claims.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("ISC-4: corpus loads with a non-trivial claim count", () => {
    expect(corpus.claims.length).toBeGreaterThanOrEqual(25);
  });

  test("ISC-5: a claim missing source is rejected by name", async () => {
    const dir = `${import.meta.dir}/fixtures/bad-corpus`;
    await Bun.write(
      `${dir}/profile.yaml`,
      // The corpus in use (the fictional example under test), never a real one.
      await Bun.file(`${CORPUS_DIR}/profile.yaml`).text(),
    );
    await Bun.write(
      `${dir}/claims.yaml`,
      "claims:\n  - id: no-source\n    employer: null\n    claim: Something\n    domains: [security]\n    skills: []\n    metric: null\n    scope: null\n    strength: 3\n",
    );
    await expect(loadCorpus(dir)).rejects.toThrow(/missing "source"/);
  });

  test("ISC-6: at least four declared gaps", () => {
    expect(corpus.profile.gaps.length).toBeGreaterThanOrEqual(4);
  });
});

describe("projection (ISC-7..12)", () => {
  test("ISC-7: iam angle puts the directory-consolidation claim in the top 3", () => {
    expect(topIds("iam", 3)).toContain("claim-idp-consolidation");
  });

  test("ISC-8: devops angle surfaces the IaC evidence in the top 3", () => {
    const top = topIds("devops", 3);
    expect(
      top.includes("claim-terraform-modules") || top.includes("claim-kubernetes-migration"),
    ).toBe(true);
  });

  test("ISC-9: ai angle ranks the MCP server first", () => {
    expect(topIds("ai", 1)[0]).toBe("claim-mcp-agent-tooling");
  });

  test("ISC-10: unknown angle falls back to strength ordering, no throw", () => {
    const result = project(corpus, "underwater basket weaving", { limit: 5 });
    expect(result.angle).toBeNull();
    const strengths = result.claims.map((p) => p.claim.strength);
    expect(strengths).toEqual([...strengths].sort((a, b) => b - a));
  });

  test("ISC-11: an angle-specific variant is used when one exists", () => {
    const mcp = corpus.byId.get("claim-mcp-agent-tooling")!;
    const { text, variantUsed } = selectText(mcp, resolveAngle("ai"));
    expect(variantUsed).toBe("ai");
    expect(text).toContain("agent");
  });

  test("ISC-12: canonical text is used when no variant matches the angle", () => {
    const sops = corpus.byId.get("claim-onboarding-sops")!;
    expect(sops.variants).toBeUndefined();
    const { variantUsed } = selectText(sops, resolveAngle("iam"));
    expect(variantUsed).toBe("canonical");
  });

  test("projection is deterministic across runs", () => {
    expect(topIds("devsecops", 10)).toEqual(topIds("devsecops", 10));
  });

  test("angle resolution prefers the longest alias", () => {
    expect(resolveAngle("cloud security")?.id).toBe("devsecops");
    expect(resolveAngle("cloud")?.id).toBe("cloud");
  });
});

describe("anti-fabrication gate (ISC-13..17)", () => {
  test("ISC-13: rejects a technology absent from the corpus", () => {
    const r = checkAntiFabrication(
      "Led the migration of our Kafka clusters across three regions.",
      corpus,
    );
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.term === "kafka")).toBe(true);
  });

  test("ISC-13b: does not false-positive on 'go' inside 'governance'", () => {
    const r = checkAntiFabrication(
      "Owned access governance and identity lifecycle management.",
      corpus,
    );
    expect(r.violations.some((v) => v.term === "golang")).toBe(false);
  });

  test("ISC-14: rejects a metric no source supports", () => {
    const r = checkAntiFabrication(
      "Managed 9500 endpoints across the estate.",
      corpus,
    );
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.kind === "metric" && v.term === "9500")).toBe(true);
  });

  test("ISC-14b: accepts the 600 endpoints metric a claim supports", () => {
    const r = checkAntiFabrication(
      "Managed 600 endpoints including BYOD assets.",
      corpus,
    );
    expect(r.violations.some((v) => v.kind === "metric")).toBe(false);
  });

  test("ISC-15: rejects a skill claimed above its declared level", () => {
    const r = checkAntiFabrication("Expert in TypeScript and distributed systems.", corpus);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.kind === "over-claim")).toBe(true);
  });

  test("ISC-15b: rejects any claim on a declared gap", () => {
    const r = checkAntiFabrication("Strong hands-on Rust systems background.", corpus);
    expect(r.violations.some((v) => v.kind === "gap" || v.kind === "technology")).toBe(true);
  });

  test("ISC-16: passes text rendered purely from corpus claims", () => {
    const rendered = project(corpus, "iam", { limit: 6 })
      .claims.map((p) => p.text)
      .join("\n");
    const r = checkAntiFabrication(rendered, corpus);
    if (!r.ok) console.error("unexpected violations:\n", r.violations);
    expect(r.ok).toBe(true);
  });

  test("ISC-16b: every angle's top-8 projection passes the gate", () => {
    for (const angle of ["iam", "devops", "devsecops", "security", "compliance", "cloud", "ai", "observability", "fullstack", "automation"]) {
      const rendered = project(corpus, angle, { limit: 8 })
        .claims.map((p) => p.text)
        .join("\n");
      const r = checkAntiFabrication(rendered, corpus);
      if (!r.ok) console.error(`angle ${angle} violations:`, r.violations);
      expect(r.ok).toBe(true);
    }
  });
});

describe("anti-fabrication: dates are not metrics", () => {
  test("REGRESSION: the letter's own date never trips the metric check", () => {
    // Found live: every cover letter was blocked because the header date's
    // day-of-month ("14") was scanned as an unattested metric. It had passed on
    // the 11th only by coincidence — "11" appears in the phone number.
    for (const day of ["01", "14", "23", "29", "31"]) {
      const r = checkAntiFabrication(`2026-09-${day}\n\nDear Hiring Manager,`, corpus);
      expect(r.violations.filter((v) => v.kind === "metric")).toEqual([]);
    }
  });

  test("a real unsupported number next to a date is still caught", () => {
    const r = checkAntiFabrication("2026-09-14 — Managed 9500 endpoints.", corpus);
    expect(r.violations.some((v) => v.term === "9500")).toBe(true);
  });
});

describe("skill matching is by word, not substring", () => {
  test("REGRESSION: a two-letter skill does not answer for a longer word", () => {
    // "Go" is declared at intermediate level; "Governance" merely contains it.
    // Substring matching made the heading "Security Compliance & Governance
    // Specialist" read as a skill claimed above its declared level.
    const r = checkAntiFabrication("Security Compliance & Governance Specialist", corpus);
    expect(r.violations.some((v) => v.kind === "over-claim")).toBe(false);
  });

  test("a real over-claim on that same skill is still caught", () => {
    const r = checkAntiFabrication("Expert in Go and distributed systems.", corpus);
    expect(r.violations.some((v) => v.kind === "over-claim" && /go/i.test(v.term))).toBe(true);
  });
});
