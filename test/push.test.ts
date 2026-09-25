/**
 * The entry-level push: entry-level detection, the citizenship /
 * clearance gate, and the role family of Portuguese and entry-level titles.
 */
import { describe, expect, test } from "bun:test";
import { loadCorpus } from "../src/corpus/load.ts";
import { isEntryLevel, ownLevelFor, withinTargetLevel, roleDomain } from "../src/pipeline/level.ts";
import { checkFit } from "../src/pipeline/fit.ts";
import { classifyRole } from "../src/pipeline/score.ts";
import { uploadSlot, yesNoRules } from "../src/pipeline/submit.ts";

const corpus = await loadCorpus();

describe("entry-level titles", () => {
  test("junior, intern, new grad, level I and Portuguese forms are entry-level", () => {
    for (const t of [
      "Junior Security Analyst", "SOC Analyst I", "IT Support Administrator I", "Software Engineering Intern (Summer 2027)",
      "Software Engineer - New Grad", "Analista de Suporte N1 Junior", "Analista de Segurança Jr", "Estágio em Segurança da Informação",
      "Associate Technical Services Engineer II", "Software Engineer, Early Career",
    ]) expect(isEntryLevel(t)).toBe(true);
  });

  test("ANTI: senior, staff and plain titles are not entry-level", () => {
    for (const t of ["Senior Security Engineer", "Staff SRE", "Security Engineer", "Information Security Engineer - Insider Risk"]) {
      expect(isEntryLevel(t)).toBe(false);
    }
  });
});

describe("citizenship / clearance gate", () => {
  test("a posting requiring US citizenship or a clearance is not a fit", () => {
    for (const d of [
      "Applicants must be a U.S. citizen due to government contract requirements.",
      "This role requires an active Top Secret clearance.",
      "Must be able to obtain and maintain a security clearance.",
      "This position is subject to ITAR.",
    ]) {
      const f = checkFit(corpus, { title: "Site Reliability Engineer", descriptionText: d });
      expect(f.ok).toBe(false);
      expect(f.check).toBe("citizenship");
    }
  });

  test("ANTI: mentioning security or citizenship in passing is not a gate", () => {
    const f = checkFit(corpus, { title: "Security Engineer", descriptionText: "You will improve our security posture. We welcome candidates of any citizenship." });
    expect(f.check).not.toBe("citizenship");
  });
});

describe("role family of entry-level and Portuguese titles", () => {
  test("technical entry titles are engineering; sales is not", () => {
    for (const t of ["Help Desk Technician", "Analista de Infraestrutura Pleno", "Engenheiro de Software Júnior", "IT Support Specialist"]) {
      expect(classifyRole(t).family).toBe("engineering");
    }
    expect(classifyRole("Sales Development Representative").family).toBe("non-engineering");
  });
});

describe("reserved-audience postings", () => {
  test("postings reserved for a group are set aside, never assumed", () => {
    for (const title of ["Analista de Segurança da Informação Jr. - SOC (Exclusiva para Pessoas com Deficiência)", "Senior Platform Engineer (Women Applicants Only)"]) {
      const f = checkFit(corpus, { title, descriptionText: "" });
      expect(f.ok).toBe(false);
      expect(f.check).toBe("reserved-audience");
    }
  });
});

describe("out-of-domain engineering in Portuguese (Brazilian-board sweep)", () => {
  test("elétrica/energia infrastructure is not IT infrastructure", () => {
    for (const title of ["TÉCNICO DE INFRAESTRUTURA ELÉTRICA JR.", "Analista Energia e Infraestrutura Jr", "Técnico de Manutenção Mecânica"]) {
      const f = checkFit(corpus, { title, descriptionText: "descrição da vaga" });
      expect(f.ok).toBe(false);
      expect(f.check).toBe("title-tech");
    }
  });

  test("ANTI: the same words qualified by TI, redes or sistemas still pass", () => {
    for (const title of ["Analista de Infraestrutura de TI Júnior", "Analista de Infraestrutura de Redes Jr", "Analista de Infraestrutura I", "Técnico de Suporte e Infraestrutura de TI Jr."]) {
      expect(checkFit(corpus, { title, descriptionText: "descrição da vaga" }).ok).toBe(true);
    }
  });
});

describe("file uploads go only where a CV or letter is asked for", () => {
  test("a disability-report upload gets nothing", () => {
    expect(uploadSlot("question_8505700005", "caso você seja uma pessoa com deficiência, por favor, anexe o seu laudo.", "Anexar")).toBe("other");
  });
  test("standard resume and cover-letter slots still resolve", () => {
    expect(uploadSlot("resume ", "currículo/cv", "Anexar")).toBe("cv");
    expect(uploadSlot("cover_letter ", "cover letter", "Attach")).toBe("letter");
    expect(uploadSlot("_systemfield_resume ", "", "Resume")).toBe("cv");
  });
  test("ANTI: an unnamed generic upload still defaults to the CV", () => {
    expect(uploadSlot(" ", "", "Upload file")).toBe("cv");
  });
});

describe("'have you applied here before' follows the pipeline's own record", () => {
  const meta = { requiresSponsorship: false, eligibilityPath: "remote-brazil-eligible" } as any;
  const answer = (q: string, appliedBefore: boolean) =>
    yesNoRules(meta, corpus, appliedBefore).find((r) => r.match.test(q))?.answer;

  test("No for a company the pipeline has not applied to", () => {
    expect(answer("Have you participated in a hiring process with Northstar Labs in the last 6 months?", false)).toBe("No");
  });
  test("Yes once the pipeline sent another role there", () => {
    expect(answer("Have you participated in a hiring process with Northstar Labs in the last 6 months?", true)).toBe("Yes");
  });
  test("ANTI: 'worked here before' stays No either way", () => {
    expect(answer("Have you previously been employed by Northstar Labs?", true)).toBe("No");
  });
});

describe("the candidate's level differs by field (senior IT, Pleno IAM, junior the rest)", () => {
  test("seniority answers follow the posting's field", () => {
    expect(ownLevelFor("Analista de Infraestrutura Sênior")).toBe("senior");
    expect(ownLevelFor("Analista de Gestão de Acessos Sênior | IAM")).toBe("pleno");
    expect(ownLevelFor("Especialista em Machine Learning Engineering - MLOps")).toBe("junior");
  });
  test("targeted: IAM at any level, IT up to senior, the rest only junior", () => {
    expect(withinTargetLevel("Senior IAM Engineer").ok).toBe(true);
    expect(withinTargetLevel("Analista de Infraestrutura Sênior").ok).toBe(true);
    expect(withinTargetLevel("Pentester Júnior").ok).toBe(true);
    expect(withinTargetLevel("Desenvolvedor Full Stack Júnior").ok).toBe(true);
    expect(withinTargetLevel("Senior Security Engineer").ok).toBe(false);
    expect(withinTargetLevel("SRE Pleno").ok).toBe(false);
    expect(withinTargetLevel("Senior Software Engineer").ok).toBe(false);
  });
  test("ANTI: identity work inside a security title counts as IAM", () => {
    expect(roleDomain("Analista de Segurança da Informação Pleno — Gestão de Vulnerabilidades e Identidades")).toBe("iam");
  });
});

test("REGRESSION: a software role on identity systems is software, not IAM", () => {
  expect(roleDomain("Senior Software Engineer, Identity")).toBe("fullstack");
  expect(withinTargetLevel("Senior Software Engineer (Identity and Access Management system)").ok).toBe(false);
  expect(roleDomain("IAM Engineer - Security")).toBe("iam");
});

describe("management titles that hide the word 'manager'", () => {
  test("a discipline lead is above the candidate's level", () => {
    for (const title of [
      "Engineering Lead, Payments Platform",
      "Technical Leader de Governança",
      "Security Lead",
      "Senior Lead Software Engineer",
      "Lead Data Engineer",
    ]) {
      const f = checkFit(corpus, { title, descriptionText: "" });
      expect(f.ok).toBe(false);
      expect(f.check).toBe("level");
    }
  });

  test("ANTI: 'lead' describing the work, not the job, still passes", () => {
    for (const title of ["Software Engineer, Lead Generation Platform", "Site Reliability Engineer"]) {
      const f = checkFit(corpus, { title, descriptionText: "" });
      expect(f.check).not.toBe("level");
    }
  });
});
