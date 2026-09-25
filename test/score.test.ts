/**
 * Scoring tests (ISC-28) — including regressions for the live failure where a
 * Sales Ops Analyst posting scored 100/100.
 */

import { describe, expect, test } from "bun:test";
import { loadCorpus } from "../src/corpus/load.ts";
import { scoreJob, classifyRole, suggestAngle } from "../src/pipeline/score.ts";
import type { NormalizedJob } from "../src/ats/types.ts";

const corpus = await loadCorpus();

const job = (title: string, descriptionText: string, locationRaw = "Remote, LATAM"): NormalizedJob => ({
  id: "1",
  atsType: "greenhouse",
  companyToken: "acme",
  title,
  url: "https://example.com/job/1",
  locationRaw,
  remotePolicy: "remote",
  descriptionText,
  fetchedAt: new Date().toISOString(),
});

const TECHNICAL_JD = `
We are looking for a Platform Engineer. You will own Terraform and Ansible
automation, run Docker workloads, administer IAM and RBAC across AWS and Azure,
maintain CI/CD pipelines in GitHub Actions, work with Python, support Linux
systems, and partner with security on ISO 27001 compliance and SIEM monitoring.
Observability with Datadog and Prometheus is part of the role.
`;

const SALES_JD = `
Elastic, the Search AI Company, enables everyone to find the answers they need.
You will build reporting and dashboards for the revenue organisation, partner
with leadership, and drive automation of our cloud reporting stack.
`;

describe("role family gate", () => {
  test("non-engineering titles are excluded", () => {
    for (const t of [
      "Sr Sales Ops Analyst",
      "Product Manager - Marketplace",
      "Customer Solution Architect (AMER)",
      "Account Executive, LATAM",
      "Technical Recruiter",
      "Associate General Counsel, Privacy Compliance",
    ]) {
      expect(classifyRole(t).fit).toBe(0);
      expect(classifyRole(t).family).toBe("non-engineering");
    }
  });

  test("engineering titles are kept", () => {
    for (const t of [
      "Security Engineer, Cloud",
      "Senior Platform Engineer",
      "Site Reliability Engineer",
      "IAM Engineer",
      "Cloud Infrastructure Engineer",
      "DevOps Engineer",
    ]) {
      expect(classifyRole(t).family).toBe("engineering");
      expect(classifyRole(t).fit).toBe(1);
    }
  });

  test("an engineering signal rescues an otherwise ambiguous analyst title", () => {
    expect(classifyRole("Security Analyst").family).toBe("engineering");
    expect(classifyRole("Sales Ops Analyst").family).toBe("non-engineering");
  });

  test("a title with both signals is ambiguous, not confidently either", () => {
    const r = classifyRole("Sales Engineer");
    expect(r.family).toBe("ambiguous");
    expect(r.fit).toBeGreaterThan(0);
    expect(r.fit).toBeLessThan(1);
  });
});

describe("scoring (ISC-28)", () => {
  test("returns 0-100 plus a breakdown citing claim ids", () => {
    const s = scoreJob(corpus, job("Platform Engineer", TECHNICAL_JD));
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(100);
    expect(s.matches.length).toBeGreaterThan(0);
    const withClaims = s.matches.filter((m) => m.viaClaims.length > 0);
    expect(withClaims.length).toBeGreaterThan(0);
    for (const m of withClaims) {
      for (const id of m.viaClaims) expect(corpus.byId.has(id)).toBe(true);
    }
  });

  test("REGRESSION: a sales posting no longer scores 100", () => {
    const s = scoreJob(corpus, job("Sr Sales Ops Analyst", SALES_JD, "Brazil"));
    expect(s.score).toBe(0);
    expect(s.roleFamily).toBe("non-engineering");
  });

  test("REGRESSION: thin technical vocabulary cannot yield a high score", () => {
    // Engineering title, but a JD naming almost nothing detectable.
    const s = scoreJob(corpus, job("Platform Engineer", "You will help the team. Python."));
    expect(s.depth).toBeLessThan(0.5);
    expect(s.score).toBeLessThan(60);
  });

  test("a dense technical posting scores well", () => {
    const s = scoreJob(corpus, job("Platform Engineer", TECHNICAL_JD));
    expect(s.score).toBeGreaterThan(60);
    expect(s.roleFamily).toBe("engineering");
    expect(s.criticalPresent).toBeGreaterThanOrEqual(4);
  });

  test("gaps list requirements with no corpus evidence", () => {
    const s = scoreJob(
      corpus,
      job("Platform Engineer", TECHNICAL_JD + "\nYou must know Kafka and Spark."),
    );
    expect(s.gaps).toContain("kafka");
  });

  test("angle suggestion is driven by the title, not company boilerplate", () => {
    const iam = suggestAngle(job("IAM Engineer", "identity access management provisioning"));
    expect(iam.best?.id).toBe("iam");
    const devops = suggestAngle(job("Senior DevOps Engineer", TECHNICAL_JD));
    expect(["devops", "cloud", "automation"]).toContain(devops.best?.id ?? "");
  });

  test("an explicit angle overrides the suggestion", () => {
    const s = scoreJob(corpus, job("Platform Engineer", TECHNICAL_JD), "iam");
    expect(s.score).toBeGreaterThan(0);
    expect(s.suggestedAngle).not.toBeNull();
  });
});
