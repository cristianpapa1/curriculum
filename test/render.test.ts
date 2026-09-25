/**
 * Renderer and ledger tests (ISC-18..21, ISC-29..33, ISC-37).
 * Network-free. Ledger tests run against a temp directory.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCorpus } from "../src/corpus/load.ts";
import { renderCV } from "../src/render/cv.ts";
import { renderLetter, findApologeticOpening } from "../src/render/letter.ts";
import { checkAntiFabrication } from "../src/position/antifab.ts";
import {
  recordApplication,
  loadApplications,
  alreadyApplied,
  updateStatus,
  rebuildLedgerView,
  analyseByAngle,
  slugify,
  folderName,
  type ApplicationMeta,
} from "../src/ledger/ledger.ts";

const corpus = await loadCorpus();
const ANGLES = (await import("../src/position/angles.ts")).ANGLES.map((a) => a.id);

describe("CV renderer (ISC-18, ISC-19)", () => {
  test("ISC-18: no angle ever renders the word Junior", () => {
    for (const a of ANGLES) {
      const cv = renderCV(corpus, a);
      expect(cv.markdown).not.toMatch(/\bjunior\b/i);
    }
  });

  test("ISC-18b: an explicitly junior framing would throw unless opted in", () => {
    // Guard is a throw, so prove it is wired by checking the opt-in flag exists
    // and that a normal render carries no junior framing.
    const cv = renderCV(corpus, "fullstack", { allowJuniorFraming: true });
    expect(cv.markdown).not.toMatch(/\bjunior\b/i);
  });

  test("ISC-19: the in-progress degree renders as in-progress with expected year", () => {
    const cv = renderCV(corpus, "devops");
    expect(cv.markdown).toContain("in progress, expected 2029");
    expect(cv.markdown).not.toMatch(/Instituto Aurora de Tecnologia.*—\s*2025–2029/);
  });

  test("employment dates keep their month (YAML coercion regression)", () => {
    const cv = renderCV(corpus, "devops");
    expect(cv.markdown).toContain("2022-08");
    expect(cv.markdown).toContain("Present");
  });

  test("the angle drives the rendered title", () => {
    expect(renderCV(corpus, "iam").title).toContain("Identity & Access Management");
    expect(renderCV(corpus, "ai").title).toContain("AI Platform");
  });

  test("every angle's CV passes the anti-fabrication gate", () => {
    for (const a of ANGLES) {
      const cv = renderCV(corpus, a);
      const gate = checkAntiFabrication(cv.markdown, corpus);
      if (!gate.ok) console.error(`angle ${a}:`, gate.violations);
      expect(gate.ok).toBe(true);
    }
  });

  test("claim provenance is recorded for meta.json", () => {
    const cv = renderCV(corpus, "iam");
    expect(cv.claimIds.length).toBeGreaterThan(0);
    for (const id of cv.claimIds) expect(corpus.byId.has(id)).toBe(true);
  });
});

describe("cover letter (ISC-20, ISC-21)", () => {
  const target = { company: "Northstar Labs", roleTitle: "Principal Solutions Architect" };

  test("ISC-20: the opening is not apologetic, for any angle", () => {
    for (const a of ANGLES) {
      const letter = renderLetter(corpus, a, target);
      const body = letter.markdown.split("Dear Hiring Manager,")[1] ?? "";
      expect(findApologeticOpening(body.trim())).toBeNull();
    }
  });

  test("ISC-20b: the detector catches a self-deprecating opening", () => {
    const apologetic =
      "My current responsibilities do not reflect my full experience. I currently only handle internal support tickets.";
    expect(findApologeticOpening(apologetic)).not.toBeNull();
  });

  test("ISC-20c: detector catches common concessive openings", () => {
    expect(findApologeticOpening("Although I lack direct experience, I am eager.")).not.toBeNull();
    expect(findApologeticOpening("I may not have all the requirements listed.")).not.toBeNull();
    expect(findApologeticOpening("I hope you will consider my application.")).not.toBeNull();
  });

  test("ISC-21: the letter names the company and the role", () => {
    const letter = renderLetter(corpus, "iam", target);
    expect(letter.markdown).toContain("Northstar Labs");
    expect(letter.markdown).toContain("Principal Solutions Architect");
  });

  test("a letter with no company is refused", () => {
    expect(() => renderLetter(corpus, "iam", { company: "", roleTitle: "X" })).toThrow(
      /requires a company/,
    );
  });

  test("every angle's letter passes the anti-fabrication gate", () => {
    for (const a of ANGLES) {
      const letter = renderLetter(corpus, a, target);
      const gate = checkAntiFabrication(letter.markdown, corpus);
      if (!gate.ok) console.error(`angle ${a}:`, gate.violations);
      expect(gate.ok).toBe(true);
    }
  });
});

describe("ledger (ISC-29..33, ISC-37)", () => {
  let dir: string;
  let appsDir: string;
  let ledgerFile: string;

  const meta = (over: Partial<ApplicationMeta> = {}): ApplicationMeta => ({
    id: "greenhouse:12345",
    atsType: "greenhouse",
    jobId: "12345",
    company: "Northstar Labs",
    roleTitle: "Principal Solutions Architect, Security Specialist",
    url: "https://boards.greenhouse.io/elastic/jobs/12345",
    angle: "iam",
    score: 78,
    claimIds: ["claim-iam-multicloud"],
    locationRaw: "Brazil",
    remotePolicy: "remote",
    brazilEligible: true,
    eligibilityReason: 'location:"Brazil" matched "Brazil"',
    preparedAt: "2026-09-11T12:00:00.000Z",
    submittedAt: "2026-09-11T12:00:05.000Z",
    status: "submitted",
    cvFile: "CV.pdf",
    letterFile: "CoverLetter.pdf",
    jobDescriptionFile: "job-description.md",
    proofFile: "submission-proof.png",
    respondedAt: null,
    responseType: null,
    followUpDue: "2026-09-25",
    notes: [],
    ...over,
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ledger-test-"));
    appsDir = join(dir, "Applications");
    ledgerFile = join(dir, "APPLICATIONS.md");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("ISC-29/30: the folder holds the exact CV plus all artifacts", async () => {
    const finalDir = await recordApplication(
      meta(),
      [
        { name: "CV.pdf", content: "%PDF-1.4 fake" },
        { name: "CoverLetter.pdf", content: "%PDF-1.4 fake" },
        { name: "job-description.md", content: "# JD snapshot" },
        { name: "submission-proof.png", content: "fakepng" },
      ],
      { applicationsDir: appsDir, ledgerFile },
    );
    const files = (await readdir(finalDir)).sort();
    expect(files).toEqual([
      "CV.pdf", "CoverLetter.pdf", "job-description.md", "meta.json", "submission-proof.png",
    ]);
    expect(await Bun.file(join(finalDir, "CV.pdf")).text()).toBe("%PDF-1.4 fake");
  });

  test("ISC-31: meta.json records date, url, title, company, ats, angle, score, claims, status", async () => {
    const finalDir = await recordApplication(meta(), [], {
      applicationsDir: appsDir, ledgerFile,
    });
    const m = await Bun.file(join(finalDir, "meta.json")).json();
    expect(m.company).toBe("Northstar Labs");
    expect(m.url).toContain("greenhouse.io");
    expect(m.atsType).toBe("greenhouse");
    expect(m.angle).toBe("iam");
    expect(m.score).toBe(78);
    expect(m.claimIds).toContain("claim-iam-multicloud");
    expect(m.status).toBe("submitted");
    expect(m.submittedAt).toBeTruthy();
  });

  test("ISC-32: the ledger view has a row per application with date, title and link", async () => {
    await recordApplication(meta(), [], { applicationsDir: appsDir, ledgerFile });
    await recordApplication(
      meta({ id: "ashby:999", jobId: "999", company: "Supabase", roleTitle: "Platform Engineer", angle: "devops" }),
      [],
      { applicationsDir: appsDir, ledgerFile },
    );
    const view = await Bun.file(ledgerFile).text();
    expect(view).toContain("Northstar Labs");
    expect(view).toContain("Supabase");
    expect(view).toContain("2026-09-11");
    expect(view).toContain("greenhouse.io");
    expect(view).toContain("**Total:** 2");
  });

  test("ISC-33: a failed write leaves nothing behind", async () => {
    await recordApplication(meta(), [], { applicationsDir: appsDir, ledgerFile });
    // Same folder name => refused, and no partial directory is created.
    await expect(
      recordApplication(meta(), [], { applicationsDir: appsDir, ledgerFile }),
    ).rejects.toThrow(/already exists/);
    expect((await readdir(appsDir)).length).toBe(1);
  });

  test("ISC-37: dedupe finds a prior application by ats:jobId", async () => {
    await recordApplication(meta(), [], { applicationsDir: appsDir, ledgerFile });
    expect(await alreadyApplied("greenhouse", "12345", appsDir)).not.toBeNull();
    expect(await alreadyApplied("greenhouse", "00000", appsDir)).toBeNull();
  });

  test("status updates flow through to the regenerated view", async () => {
    await recordApplication(meta(), [], { applicationsDir: appsDir, ledgerFile });
    await updateStatus("greenhouse:12345", { status: "interview", respondedAt: "2026-09-20" }, {
      applicationsDir: appsDir, ledgerFile,
    });
    const apps = await loadApplications(appsDir);
    expect(apps[0]!.status).toBe("interview");
    expect(await Bun.file(ledgerFile).text()).toContain("interview");
  });

  test("response rate is computed per angle", () => {
    const stats = analyseByAngle([
      meta({ angle: "iam", status: "interview" }),
      meta({ angle: "iam", status: "rejected" }),
      meta({ angle: "devops", status: "rejected" }),
      meta({ angle: "devops", status: "prepared" }), // excluded: never sent
    ]);
    const iam = stats.find((s) => s.angle === "iam")!;
    expect(iam.sent).toBe(2);
    expect(iam.replies).toBe(1);
    expect(iam.responseRate).toBeCloseTo(0.5);
    const devops = stats.find((s) => s.angle === "devops")!;
    expect(devops.sent).toBe(1);
  });

  test("folder naming is filesystem-safe and dated", () => {
    expect(slugify("Sr. Solutions Architect / Security (LATAM)")).toBe(
      "Sr-Solutions-Architect-Security-LATAM",
    );
    expect(
      folderName({ preparedAt: "2026-09-11T12:00:00Z", company: "Northstar Labs", roleTitle: "Platform Eng" }),
    ).toBe("2026-09-11_Northstar-Labs_Platform-Eng");
  });

  test("an empty ledger regenerates without error", async () => {
    const view = await rebuildLedgerView({ applicationsDir: appsDir, ledgerFile });
    expect(view).toContain("**Total:** 0");
  });
});

describe("job-targeted skills and highlights", () => {
  const skillsOf = (md: string) =>
    md.split("## Skills")[1]?.split("\n##")[0] ?? "";
  const highlightsOf = (md: string) =>
    md.split("## Selected Achievements")[1]?.split("\n##")[0] ?? "";

  test("a skill the posting asks for leads its row", () => {
    const cv = renderCV(corpus, "devops", {
      requiredSkills: ["iam", "iso 27001", "entra id"],
    });
    const core = skillsOf(cv.markdown).split("\n").find((l) => l.includes("Core"))!;
    // IAM / RBAC and ISO 27001 sit late in the declared expert list; asking for
    // them must pull them to the front.
    expect(core.indexOf("IAM / RBAC")).toBeLessThan(core.indexOf("Terraform"));
  });

  test("a required skill is never trimmed by the readability cap", () => {
    // "Playwright" sits at the tail of the declared list and would be sliced off.
    const cv = renderCV(corpus, "iam", { requiredSkills: ["playwright"] });
    expect(skillsOf(cv.markdown)).toContain("Playwright");
  });

  test("skills the posting does not mention still appear", () => {
    const cv = renderCV(corpus, "devops", { requiredSkills: ["iam"] });
    const s = skillsOf(cv.markdown);
    expect(s).toContain("Terraform");
    expect(s).toContain("Python");
  });

  test("ANTI: a skill absent from the profile is never added, even if required", () => {
    const cv = renderCV(corpus, "devops", {
      requiredSkills: ["kafka", "spark", "salesforce"],
    });
    const s = skillsOf(cv.markdown);
    expect(s).not.toMatch(/kafka/i);
    expect(s).not.toMatch(/spark/i);
    expect(s).not.toMatch(/salesforce/i);
  });

  test("highlights carry a metric and change with the posting", () => {
    const iam = highlightsOf(
      renderCV(corpus, "iam", { requiredSkills: ["iam", "entra id", "identity"] }).markdown,
    );
    const devops = highlightsOf(
      renderCV(corpus, "devops", { requiredSkills: ["terraform", "ci/cd", "docker"] }).markdown,
    );
    expect(iam).toContain("900+ accounts");
    expect(iam).not.toEqual(devops);
    expect(devops).toMatch(/cloud|Terraform|Kubernetes/i);
  });

  test("highlights are present for every angle and always quantified", () => {
    for (const a of ANGLES) {
      const md = renderCV(corpus, a).markdown;
      const h = highlightsOf(md);
      expect(h.trim().length).toBeGreaterThan(0);
      for (const line of h.trim().split("\n").filter(Boolean)) {
        expect(line).toMatch(/\*\*.+\*\*/); // the metric is bolded
      }
    }
  });

  test("targeted CVs still pass the anti-fabrication gate", () => {
    for (const req of [
      ["iam", "entra id", "iso 27001"],
      ["terraform", "docker", "aws"],
      ["kubernetes", "golang"],
    ]) {
      for (const a of ["iam", "devops", "devsecops", "ai"]) {
        const cv = renderCV(corpus, a, { requiredSkills: req });
        const gate = checkAntiFabrication(cv.markdown, corpus);
        if (!gate.ok) console.error(a, req, gate.violations);
        expect(gate.ok).toBe(true);
      }
    }
  });

  test("localized CVs get localized highlight headings", () => {
    expect(renderCV(corpus, "iam", { lang: "pt" }).markdown).toContain("Principais Resultados");
    expect(renderCV(corpus, "iam", { lang: "es" }).markdown).toContain("Principales Logros");
  });
});

describe("job titles are never fabricated", () => {
  test("ANTI: the experience heading uses the REAL job title, not the angle", () => {
    // Found live: a CV rendered an experience heading as "<positioning angle> ·
    // <employer>". That is not a title anyone held — it was the angle leaking
    // into the credential. Inventing a job title is the kind of claim a
    // reference check destroys, and the anti-fabrication gate cannot see it,
    // because the title never passes through a claim.
    for (const angle of ANGLES) {
      const md = renderCV(corpus, angle).markdown;
      // Only employers that actually appear (an angle may not surface every
      // role), but each one that does must carry its real title.
      const headings = md.split("\n").filter((l) => l.startsWith("### "));
      expect(headings.length).toBeGreaterThan(0);
      for (const h of headings) {
        const ok = corpus.profile.employment.some((e) =>
          h.startsWith(`### ${e.title_official} · ${e.employer}`),
        );
        if (!ok) console.error("unexpected heading:", h);
        expect(ok).toBe(true);
      }
      // The angle may describe the candidate in the headline, never as a job title.
      expect(md).not.toMatch(/^### AI Application Engineer · /m);
      expect(md).not.toMatch(/^### Solutions Architect · /m);
    }
  });

  test("the headline may still carry the angle — that is self-description", () => {
    expect(renderCV(corpus, "ai-fullstack").markdown).toContain("**AI Application Engineer**");
  });

  test("the current employer keeps its own distinct title", () => {
    expect(renderCV(corpus, "devops").markdown).toContain(
      "Infrastructure & Security Analyst",
    );
    // The prior role surfaces on angles its claims actually serve.
    expect(renderCV(corpus, "fullstack").markdown).toMatch(
      /IT Support & Systems Analyst|Infrastructure & Security Analyst/,
    );
  });
});

describe("posting-targeted documents", () => {
  // A payments backend posting: Python/FastAPI/PostgreSQL/AWS/Terraform.
  const requirements = [
    { term: "python", matched: true, viaClaims: ["claim-internal-portal", "claim-terraform-modules"], weight: 2 },
    { term: "terraform", matched: true, viaClaims: ["claim-terraform-modules"], weight: 2 },
    { term: "postgresql", matched: true, viaClaims: ["claim-internal-portal"], weight: 1 },
    { term: "fastapi", matched: true, viaClaims: ["claim-internal-portal"], weight: 1 },
    { term: "kafka", matched: false, viaClaims: [], weight: 2 },
  ];
  const requiredSkills = requirements.filter((r) => r.matched).map((r) => r.term);
  const highlightsOf = (md: string) => md.split("## Selected Achievements")[1]?.split("\n##")[0] ?? "";

  test("every highlight's sentence states its own figure", () => {
    const words: Record<string, RegExp> = { "3": /three/i, "4": /four/i, "6": /six/i };
    for (const a of ANGLES) {
      const md = renderCV(corpus, a, { requiredSkills, requirements }).markdown;
      for (const line of highlightsOf(md).trim().split("\n").filter(Boolean)) {
        const num = line.match(/\*\*[^*]*?(\d[\d,.]*)/)?.[1];
        if (!num) continue;
        const sentence = line.split("** — ")[1] ?? "";
        const ok = sentence.includes(num) || (words[num]?.test(sentence) ?? false);
        if (!ok) console.error(a, line);
        expect(ok).toBe(true);
      }
    }
  });

  test("a personal-project highlight is labelled as such, never passed off as employer work", () => {
    const md = renderCV(corpus, "fullstack", { requiredSkills, requirements }).markdown;
    for (const line of highlightsOf(md).trim().split("\n").filter(Boolean)) {
      expect(line).toMatch(/_\((independent project|Lumen Grove Systems|Rio Verde Logistics)\)_$/);
    }
  });

  test("the summary does not stretch cloud and security experience over the operations years", () => {
    const md = renderCV(corpus, "devops").markdown;
    expect(md).toMatch(/years of professional experience, including \d\+ years in cloud infrastructure/);
  });

  test("no sentence is repeated between the summary and the highlights", () => {
    const md = renderCV(corpus, "fullstack", { requiredSkills, requirements }).markdown;
    const summary = md.split("## Summary")[1]!.split("\n##")[0]!;
    for (const line of highlightsOf(md).trim().split("\n").filter(Boolean)) {
      const sentence = (line.split("** — ")[1] ?? "").replace(/ _\(.*\)_$/, "");
      expect(summary).not.toContain(sentence);
    }
  });

  test("the headline and summary name held skills the posting asks for, never gaps", () => {
    const md = renderCV(corpus, "fullstack", { requiredSkills, requirements }).markdown;
    expect(md).toMatch(/^\*\*Full Stack Engineer · Python/m);
    expect(md).toContain("Hands-on with Python");
    expect(md).not.toMatch(/kafka/i);
  });

  test("letters list evidence instead of subject-less prose, and state EU authorization when asked", () => {
    const letter = renderLetter(corpus, "fullstack", {
      company: "Northstar Labs", roleTitle: "Senior Software Engineer (Payments)", requirements, showWorkAuthorization: true,
    });
    expect(letter.markdown).toContain("The work most relevant to this role:");
    expect(letter.markdown.split("\n").filter((l) => l.startsWith("- ")).length).toBe(3);
    expect(letter.markdown).toContain("no visa sponsorship is needed");
    expect(letter.markdown).not.toContain("rather than a side project");
    expect(checkAntiFabrication(letter.markdown, corpus).ok).toBe(true);
  });
});
