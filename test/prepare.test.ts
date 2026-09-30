/**
 * The per-company cap.
 *
 * A cap keeps one batch from collapsing onto three employers. What it must not
 * do is lock a company out over applications that were never sent: three closed
 * postings, all withdrawn, used up a company's slots and the next real opening
 * there was skipped in silence.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorpus } from "../src/corpus/load.ts";
import { prepareApplications } from "../src/pipeline/prepare.ts";
import { project } from "../src/position/project.ts";

const corpus = await loadCorpus();

const posting = (title: string, url: string) => `company: Northstar Labs
title: ${title}
url: ${url}
location: Remote, Brazil
remote: remote
description: |
  Platform engineering role. Terraform, Docker, Python, PostgreSQL, IAM.
`;

/** An applications directory holding one prior application at `status`. */
function withPrior(status: string, count = 1): string {
  const dir = mkdtempSync(join(tmpdir(), "curriculum-apps-"));
  for (let i = 0; i < count; i++) {
    const folder = join(dir, `2026-09-0${i + 1}_Northstar-Labs_Prior-Role-${i}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "meta.json"),
      JSON.stringify({
        id: `manual:prior-${i}`,
        atsType: "manual",
        jobId: `prior-${i}`,
        company: "Northstar Labs",
        roleTitle: `Prior Role ${i}`,
        url: `https://example.com/prior-${i}`,
        angle: "devops",
        score: 50,
        claimIds: [],
        locationRaw: "Remote, Brazil",
        remotePolicy: "remote",
        brazilEligible: true,
        eligibilityReason: "remote",
        eligibilityPath: "remote-brazil-eligible",
        requiresSponsorship: false,
        lang: "en",
        preparedAt: "2026-09-01T00:00:00.000Z",
        submittedAt: null,
        status,
        cvFile: "CV.pdf",
        letterFile: "CoverLetter.pdf",
        jobDescriptionFile: "job-description.md",
        proofFile: null,
        respondedAt: null,
      }),
    );
  }
  return dir;
}

function postingFile(title: string, url: string): string {
  const dir = mkdtempSync(join(tmpdir(), "curriculum-postings-"));
  const path = join(dir, "posting.yaml");
  writeFileSync(path, posting(title, url));
  return path;
}

describe("the per-company cap counts what was sent", () => {
  test("REGRESSION: withdrawn applications do not spend a company's slots", async () => {
    const applicationsDir = withPrior("withdrawn", 3);
    const result = await prepareApplications(
      corpus,
      [{ atsType: "manual", token: postingFile("Platform Engineer", "https://example.com/new-1") }],
      { limit: 1, minScore: 0, pdf: false, perCompanyCap: 3, applicationsDir },
    );
    expect(result.prepared.length).toBe(1);
  });

  test("applications that were sent still count", async () => {
    const applicationsDir = withPrior("submitted", 3);
    const result = await prepareApplications(
      corpus,
      [{ atsType: "manual", token: postingFile("Platform Engineer", "https://example.com/new-2") }],
      { limit: 1, minScore: 0, pdf: false, perCompanyCap: 3, applicationsDir },
    );
    expect(result.prepared.length).toBe(0);
  });

  test("the cap says so instead of preparing nothing in silence", async () => {
    const applicationsDir = withPrior("submitted", 3);
    const result = await prepareApplications(
      corpus,
      [{ atsType: "manual", token: postingFile("Platform Engineer", "https://example.com/new-3") }],
      { limit: 1, minScore: 0, pdf: false, perCompanyCap: 3, applicationsDir },
    );
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]!.reason).toMatch(/per-company cap/);
  });
});

describe("the candidate's own emphasis (preferences.yaml positioning)", () => {
  const NEUTRAL = { preferCurrentEmployer: 1, preferIndependentWork: 1 };

  test("independent work can be pulled forward", () => {
    const neutral = project(corpus, "devops", { limit: 40, positioning: NEUTRAL }).claims;
    const weighted = project(corpus, "devops", {
      limit: 40,
      positioning: { preferCurrentEmployer: 1, preferIndependentWork: 3 },
    }).claims;

    const firstOwn = (list: typeof neutral) => list.findIndex((p) => !p.claim.employer);
    expect(firstOwn(weighted)).toBeLessThan(firstOwn(neutral));
  });

  test("the current employer can be pulled forward", () => {
    const current = corpus.profile.employment.find((e) => e.current)!.id;
    const neutral = project(corpus, "fullstack", { limit: 40, positioning: NEUTRAL }).claims;
    const weighted = project(corpus, "fullstack", {
      limit: 40,
      positioning: { preferCurrentEmployer: 3, preferIndependentWork: 1 },
    }).claims;

    const countIn = (list: typeof neutral, n: number) =>
      list.slice(0, n).filter((p) => p.claim.employer === current).length;
    expect(countIn(weighted, 6)).toBeGreaterThanOrEqual(countIn(neutral, 6));
    expect(countIn(weighted, 6)).toBeGreaterThan(0);
  });

  test("ANTI: weighting never adds a claim the corpus does not hold", () => {
    const neutral = project(corpus, "devops", { limit: 100, positioning: NEUTRAL }).claims;
    const weighted = project(corpus, "devops", {
      limit: 100,
      positioning: { preferCurrentEmployer: 5, preferIndependentWork: 5 },
    }).claims;
    expect(new Set(weighted.map((p) => p.claim.id))).toEqual(new Set(neutral.map((p) => p.claim.id)));
  });
});
