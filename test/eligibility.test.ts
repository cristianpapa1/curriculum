/**
 * Eligibility tests.
 *
 * The decisive fact: the persona holds an EU citizenship (Polish) alongside the
 * Brazilian one. That means full EU/EEA work rights with NO sponsorship — and
 * "will you require sponsorship?" is the question that eliminates the most
 * candidates on an application form. Getting this wrong in either direction is
 * expensive: claiming sponsorship is needed loses EU roles that were winnable,
 * claiming it is not needed for the US or UK is a false statement.
 */

import { describe, expect, test } from "bun:test";
import { loadCorpus } from "../src/corpus/load.ts";
import { classifyEligibility, brazilCityAccepted } from "../src/pipeline/eligibility.ts";
import { workAuthorizationAnswers, standardAnswers, sourceAnswer, needsHuman } from "../src/pipeline/formanswers.ts";
import type { NormalizedJob } from "../src/ats/types.ts";

const corpus = await loadCorpus();

const job = (locationRaw: string, remotePolicy: NormalizedJob["remotePolicy"] = "onsite"): NormalizedJob => ({
  id: "1", atsType: "greenhouse", companyToken: "x", title: "Platform Engineer",
  url: "https://example.com", locationRaw, remotePolicy, descriptionText: "",
  fetchedAt: new Date().toISOString(),
});

describe("EU citizenship removes the sponsorship barrier", () => {
  test("EU countries are eligible WITHOUT sponsorship", () => {
    for (const loc of ["Helsinki, Finland", "Berlin, Germany", "Amsterdam, Netherlands", "Dublin, Ireland", "Lisbon, Portugal", "Madrid, Spain"]) {
      const v = classifyEligibility(job(loc, "hybrid"));
      expect(v.eligible).toBe(true);
      expect(v.path).toBe("relocation-europe");
      expect(v.requiresSponsorship).toBe(false);
      expect(v.reason).toContain("NO sponsorship");
    }
  });

  test("the UK still requires sponsorship post-Brexit", () => {
    const v = classifyEligibility(job("London, United Kingdom", "hybrid"));
    expect(v.eligible).toBe(true);
    expect(v.requiresSponsorship).toBe(true);
    expect(v.reason).toMatch(/Brexit/i);
  });

  test("the US still requires sponsorship", () => {
    const v = classifyEligibility(job("Seattle, WA", "hybrid"));
    expect(v.path).toBe("relocation-us");
    expect(v.requiresSponsorship).toBe(true);
  });

  test("hybrid work outside Europe, the US and Brazil is still rejected", () => {
    for (const loc of ["Singapore", "Tokyo, Japan"]) {
      expect(classifyEligibility(job(loc, "hybrid")).eligible).toBe(false);
    }
  });

  test("place-bound work in the home city is accepted locally, with no sponsorship", () => {
    const v = classifyEligibility(job("Belo Horizonte, Brazil", "hybrid"));
    expect(v.eligible).toBe(true);
    expect(v.path).toBe("brazil-local");
    expect(v.requiresSponsorship).toBe(false);
  });

  test("remote US-only roles are tried, and always need sponsorship", () => {
    const v = classifyEligibility(job("Remote - US", "remote"));
    expect(v.eligible).toBe(true);
    expect(v.path).toBe("relocation-us");
    expect(v.requiresSponsorship).toBe(true);
  });
});

describe("form answers on work authorization", () => {
  test("EU roles answer authorized=true, sponsorship=false", () => {
    const a = workAuthorizationAnswers(corpus, { country: "Finland" });
    expect(a[0]!.value).toBe(true);
    expect(a[1]!.value).toBe(false);
  });

  test("Italy itself answers authorized=true", () => {
    const a = workAuthorizationAnswers(corpus, { country: "Italy" });
    expect(a[0]!.value).toBe(true);
  });

  test("Brazil answers authorized=true", () => {
    const a = workAuthorizationAnswers(corpus, { country: "Brazil" });
    expect(a[0]!.value).toBe(true);
    expect(a[1]!.value).toBe(false);
  });

  test("the US answers truthfully: not authorized, sponsorship required", () => {
    const a = workAuthorizationAnswers(corpus, { country: "United States" });
    expect(a[0]!.value).toBe(false);
    expect(a[1]!.value).toBe(true);
  });

  test("ANTI: sponsorship answers are derived, never discretionary", () => {
    for (const country of ["Finland", "United States", "Brazil", "United Kingdom"]) {
      for (const a of workAuthorizationAnswers(corpus, { country })) {
        expect(a.confidence).toBe("derived");
      }
    }
  });
});

describe("stated facts", () => {
  test("veteran, political office and relatives are all false", () => {
    const answers = standardAnswers(corpus, { country: "Finland", companyName: "Aurora Systems" });
    const byQ = (re: RegExp) => answers.find((a) => re.test(a.question))!;
    expect(byQ(/veteran/i).value).toBe(false);
    expect(byQ(/political office/i).value).toBe(false);
    expect(byQ(/relatives/i).value).toBe(false);
    expect(byQ(/previously been employed/i).value).toBe(false);
  });

  test("ANTI: the application source is never an employee referral", () => {
    for (const ats of ["greenhouse", "lever", "ashby", "workable", "smartrecruiters", undefined]) {
      const a = sourceAnswer({ atsType: ats });
      expect(String(a.value).toLowerCase()).not.toContain("referral");
    }
  });
});

describe("questions that must reach a human", () => {
  test("salary history, notice period and open-ended prose escalate", () => {
    expect(needsHuman("What is your current salary?")).toBe(true);
    expect(needsHuman("What is your notice period?")).toBe(true);
    expect(needsHuman("Why are you leaving your current role?")).toBe(true);
    expect(needsHuman("Do you have a criminal record?")).toBe(true);
  });

  test("routine fields do not escalate", () => {
    expect(needsHuman("Are you authorized to work in Finland?")).toBe(false);
    expect(needsHuman("First name")).toBe(false);
  });
});

describe("submission pack work-authorization answers", () => {
  test("ANTI: a remote-Brazil role answers AUTHORIZED, not 'not authorized'", async () => {
    // Found live in SUBMIT.md: a "Remote, Global" posting produced
    //   "Are you legally authorized to work in Remote (global)? → false"
    // The work happens in Brazil, where the candidate IS authorized. Answering no is a
    // false statement against himself and an automatic rejection.
    const { buildSubmitPack } = await import("../src/pipeline/submitpack.ts");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { recordApplication } = await import("../src/ledger/ledger.ts");

    const dir = await mkdtemp(join(tmpdir(), "pack-"));
    const appsDir = join(dir, "Applications");
    try {
      await recordApplication(
        {
          id: "ashby:1", atsType: "ashby", jobId: "1",
          company: "Northstar Labs", roleTitle: "Platform Engineer",
          url: "https://example.com/1", angle: "devops", score: 80,
          claimIds: [], locationRaw: "Remote, Global", remotePolicy: "remote",
          brazilEligible: true, eligibilityReason: "global",
          eligibilityPath: "remote-brazil-eligible", requiresSponsorship: false,
          lang: "en", preparedAt: "2026-09-11T00:00:00.000Z", submittedAt: null,
          status: "prepared", cvFile: "CV.pdf", letterFile: "CoverLetter.pdf",
          jobDescriptionFile: "job-description.md", proofFile: null,
          respondedAt: null, responseType: null, followUpDue: null, notes: [],
        },
        [{ name: "match-report.json", content: JSON.stringify({ gaps: [] }) }],
        { applicationsDir: appsDir, ledgerFile: join(dir, "L.md") },
      );

      const outFile = join(dir, "SUBMIT.md");
      await buildSubmitPack(corpus, { applicationsDir: appsDir, outFile });
      const pack = await Bun.file(outFile).text();

      expect(pack).toContain("authorized to work in Brazil? | **true**");
      expect(pack).not.toContain("Remote (global)? | **false**");
      expect(pack).toContain("require visa sponsorship? | **false**");
      // The attachment path must be the folder that exists on disk.
      expect(pack).toMatch(/Applications\/2026-09-11_Northstar-Labs_Platform-Engineer\/CV\.pdf/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("multi-office postings", () => {
  test("REGRESSION: an office list with any EU city needs no sponsorship", () => {
    // "San Francisco, Palo Alto, London, Berlin, Belgrade, New York City" was
    // marked sponsorship-required because it mentions London; Berlin needs no visa.
    const v = classifyEligibility(job("San Francisco, Palo Alto, London, Berlin, Belgrade, New York City", "onsite"));
    expect(v.path).toBe("relocation-europe");
    expect(v.requiresSponsorship).toBe(false);
  });
  test("a London-only posting still needs sponsorship", () => {
    expect(classifyEligibility(job("London, United Kingdom", "hybrid")).requiresSponsorship).toBe(true);
  });
});

describe("place-bound Brazil: the home metro and the cities in the relocation list", () => {
  test("home and the cities the candidate would move to are accepted", () => {
    for (const l of ["Belo Horizonte, Minas Gerais, Brasil", "Contagem, Minas Gerais, Brasil", "Florianópolis, Santa Catarina, Brasil", "Recife - PE", "Brazil"]) {
      expect(brazilCityAccepted(l)).toBe(true);
    }
  });
  test("REGRESSION: a state name is not the city — Juiz de Fora, Minas Gerais is Juiz de Fora", () => {
    expect(brazilCityAccepted("Juiz de Fora, Minas Gerais, Brasil")).toBe(false);
    expect(brazilCityAccepted("Blumenau, Santa Catarina, Brasil")).toBe(false);
  });
  test("other Brazilian cities are not", () => {
    expect(brazilCityAccepted("Campinas, São Paulo, Brasil")).toBe(false);
    expect(brazilCityAccepted("Salvador BA")).toBe(false);
  });
});

test("REGRESSION: Porto Alegre is not Porto, Portugal", () => {
  const path = (l: string) => classifyEligibility({ title: "Engineer", locationRaw: l, remotePolicy: "hybrid", descriptionText: "" } as any).path;
  expect(path("Porto Alegre, RS, Brazil")).not.toBe("relocation-europe");
  expect(path("Porto, Portugal")).toBe("relocation-europe");
});
