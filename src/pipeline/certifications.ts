/**
 * Certifications related to one posting — the `__CERTS__` variable.
 *
 * The variable names the certifications the posting gives a reason to mention,
 * and only those. With none related it is empty, and whatever would have used it
 * says nothing about certifications at all — a candidate who lists a database
 * exam on a security role looks like someone padding a CV.
 *
 * Relation is judged on the posting's TITLE and REQUIREMENT TERMS, not its full
 * text: descriptions carry company boilerplate ("security", "data", "global
 * network"), and matched that way a back-end role related to every certification
 * on file.
 *
 * A certification is related when the posting mentions one of its SPECIFIC
 * domains — security, networking, database… `cloud` sits on almost every cloud
 * certification, so on its own it relates only the architecture ones: otherwise
 * any posting saying "cloud" pulled in the whole list. `operations` and
 * `automation` never count on their own: nearly every posting says them.
 */

import type { Certification, Corpus } from "../corpus/types.ts";

const DOMAIN_SIGNALS: Record<string, RegExp> = {
  cloud: /\bcloud\b|\bnuvem\b|\boci\b|oracle cloud|\baws\b|\bazure\b|\bgcp\b|google cloud/i,
  multicloud: /multi-?cloud|hybrid cloud|nuvem h[íi]brida|multinuvem/i,
  architecture: /\barchitect|\barquitet/i,
  database: /\bdatabases?\b|\bdba\b|\bsql\b|postgres|mysql|autonomous database|banco de dados|bancos de dados/i,
  devops: /devops|\bsre\b|site reliability|platform engineer|infrastructure as code|terraform/i,
  cicd: /ci\s*\/\s*cd|continuous (integration|delivery|deployment)|integra[çc][ãa]o cont[íi]nua/i,
  networking: /\bnetwork|\bredes\b|\bvpn\b|firewall|\bdns\b|\bbgp\b|load balanc|\bnoc\b/i,
  observability: /observability|observabilidade|monitoring|monitoramento|prometheus|grafana|datadog/i,
  monitoring: /monitoring|monitoramento|\bnoc\b/i,
  sre: /\bsre\b|site reliability|reliability engineer/i,
  security: /security|seguran[çc]a|cyber|ciberseguran|\bsoc\b/i,
  iam: /\biam\b|\bidentity\b|access management|gest[ãa]o de acessos|identidade/i,
};

const GENERIC = new Set(["cloud", "operations", "automation"]);

/** What relation is judged on: the title plus every requirement term the posting names. */
export function postingSignals(title: string, requirementTerms: string[]): string {
  return `${title}\n${requirementTerms.join(", ")}`;
}

/** Signals for a prepared application, from its match report (title only if absent). */
export async function signalsForFolder(dir: string, title: string): Promise<string> {
  const report = (await Bun.file(`${dir}/match-report.json`).json().catch(() => null)) as { matches?: { term: string }[] } | null;
  return postingSignals(title, (report?.matches ?? []).map((m) => m.term));
}

/** Related certifications, most related first. Empty when none relate. */
export function relevantCertifications(corpus: Corpus, signals: string): Certification[] {
  const cloud = DOMAIN_SIGNALS.cloud!.test(signals);
  return corpus.profile.certifications
    .map((c) => {
      const specific = c.domains.filter((d) => !GENERIC.has(d) && DOMAIN_SIGNALS[d]?.test(signals)).length;
      const foundational = cloud && c.domains.includes("cloud") && c.domains.includes("architecture");
      return { c, specific, related: specific > 0 || foundational };
    })
    .filter((x) => x.related)
    .sort((a, b) => b.specific - a.specific || a.c.name.localeCompare(b.c.name))
    .map((x) => x.c);
}

/** The variable's text: names joined for a form field, or "" when none relate. */
export function certificationsText(certs: Certification[], max = 5): string {
  return certs.slice(0, max).map((c) => c.name).join("; ");
}
