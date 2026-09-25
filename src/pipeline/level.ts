/**
 * Entry-level title detection.
 *
 * A candidate who needs a visa for the US is rarely sponsored above entry level,
 * so the US lane is limited to entry-level titles while the home country is not.
 * Which levels to target per field is the candidate's own policy (preferences).
 */

import { loadPolicy, type Policy, type Field, type OwnLevel } from "../corpus/policy.ts";

export const ENTRY_LEVEL =
  /\b(junior|jr\.?|j[úu]nior|entry[- ]level|associate|intern(ship)?|est[áa]gi[oá]|estagi[áa]rio|trainee|new grad(uate)?|graduate|early[- ]career|apprentice|tier (1|i)|level (1|i))\b|\b(analyst|engineer|specialist|technician|administrator|analista|engenheiro|developer|desenvolvedor) (i|1)\b|\bn1\b/i;

/**
 * A senior or leadership marker overrides any entry signal: "Senior Software
 * Engineer I/II" matched "engineer i" and was prepared as a junior US role.
 */
const SENIOR_MARKER = /\b(senior|sr\.?|s[êe]nior|lead|staff|principal|head|manager|director|especialista|master|pleno)\b/i;

export const isEntryLevel = (title: string) => ENTRY_LEVEL.test(title) && !SENIOR_MARKER.test(title);

/**
 * A candidate's level often differs by field — one real candidate was senior in
 * IT operations, mid-level in IAM and junior everywhere else. The field decides
 * two things: which postings are worth applying to (`withinTargetLevel`) and
 * what a form is told when it asks which seniority the candidate identifies
 * with (`ownLevelFor`). Both read the candidate's policy (corpus/policy.ts).
 */
export type RoleDomain = Field;
export type { OwnLevel };

const IAM = /\b(iam|identity|identidades?|gest[ãa]o de acessos?|access management|controle de acessos?|iga|pam|privileged access|entra id|active directory|okta|sailpoint|cyberark|saviynt)\b/i;
const SECURITY = /\b(security|seguran[çc]a|cyber\w*|ciberseguran[çc]a|soc|blue team|red team|pentest\w*|pen[- ]?tester|offensive|threat|vulnerab\w*|incident response|dfir|forensics?|appsec|devsecops|grc)\b/i;
const FULLSTACK = /\b(full ?stack|front[- ]?end|back[- ]?end|software (engineer|developer)|desenvolvedora?|developer|programador|engenheir[oa] de software|web developer)\b/i;
const ENGINEERING_OTHER = /\b(devops|sre|site reliability|platform engineer|plataforma|cloud|nuvem|data|dados|machine learning|mlops|\bml\b|\bai\b)\b/i;
const IT = /\b(it|ti|t\.i\.)\b|infraestrutura|infrastructure|sysadmin|systems? admin\w*|administrador de (sistemas|redes)|suporte|support|service desk|help ?desk|\bnoc\b|endpoint|\bredes\b|network|windows server|it operations|opera[çc][õo]es de ti|\bn[12]\b/i;

/**
 * The field a posting belongs to, judged on its title. IAM wins over security;
 * a software-engineering title wins over IAM — "Senior Software Engineer,
 * Identity" builds identity systems, it does not run them.
 */
export function roleDomain(title: string): RoleDomain {
  if (FULLSTACK.test(title) && !/iam engineer/i.test(title)) return "fullstack";
  if (IAM.test(title)) return "iam";
  if (SECURITY.test(title)) return "security";
  if (FULLSTACK.test(title)) return "fullstack";
  if (ENGINEERING_OTHER.test(title)) return "other";
  if (IT.test(title)) return "it";
  return "other";
}

/** What the candidate answers to "which seniority do you identify with" for this posting. */
export function ownLevelFor(title: string, policy: Policy = loadPolicy()): OwnLevel {
  const own = policy.ownLevels;
  return own[roleDomain(title)] ?? own.other ?? "junior";
}

/**
 * Whether a posting sits at a level the candidate targets in its field
 * (`targeting.focus_levels` in preferences.yaml). "any" and "up_to_senior" pass
 * every title — above-senior titles are already filtered by the fit gate —
 * and "junior" passes only titles that say junior or entry level.
 */
export function withinTargetLevel(title: string, policy: Policy = loadPolicy()): { ok: boolean; reason: string } {
  const domain = roleDomain(title);
  const target = policy.focusLevels[domain] ?? "any";
  if (target !== "junior") return { ok: true, reason: `${domain} — ${target.replace(/_/g, " ")}` };
  return isEntryLevel(title)
    ? { ok: true, reason: `${domain} — junior` }
    : { ok: false, reason: `${domain} role above junior — the candidate targets junior in this field` };
}
