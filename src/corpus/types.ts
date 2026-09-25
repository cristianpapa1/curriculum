/**
 * Career corpus types.
 *
 * The corpus is the single source of truth about the candidate. Every word that
 * reaches a hiring manager must trace back to a `Claim.source` string, which
 * quotes the original CV. This is what makes the anti-fabrication gate
 * mechanical rather than a matter of the model's good intentions.
 */

export type SkillLevel = "expert" | "proficient" | "intermediate" | "familiar";

export interface Claim {
  id: string;
  /** Employment id from profile.employment, or null for personal work. */
  employer: string | null;
  /** Canonical factual statement. Used when no angle variant applies. */
  claim: string;
  /**
   * Angle-specific rewordings. Each MUST be supported by `source`; a variant
   * may re-emphasise or re-order, never add a fact. Keyed by angle name.
   */
  variants?: Record<string, string>;
  /** Ordered by centrality — domains[0] is what this claim is most about. */
  domains: string[];
  skills: string[];
  metric: string | null;
  scope: string | null;
  /** 1-5: how differentiating this claim is in a competitive pool. */
  strength: number;
  /** Verbatim quote from the source CV. Non-empty is enforced at load. */
  source: string;
}

export interface EducationEntry {
  institution: string;
  degree: string;
  start: number;
  end: number;
  /** 1–12, only where a source states the month. */
  start_month?: number;
  end_month?: number;
  status: "completed" | "in_progress";
  /** How application-form dropdowns name this entry (not the CV's wording). */
  form?: {
    level: "bachelor" | "technical_high_school";
    discipline: string[];
    school: string[];
  };
  differentiator_for?: string[];
}

export interface Certification {
  name: string;
  year: number;
  domains: string[];
}

export interface EmploymentEntry {
  id: string;
  employer: string;
  title_official: string;
  start: string;
  end: string | null;
  current: boolean;
  context: string;
}

export interface Gap {
  skill: string;
  note: string;
}

export interface Profile {
  identity: {
    name: string;
    location: string;
    timezone: string;
    email: string;
    phone: string;
    website: string;
    github: string;
    hub?: string;
    linkedin?: string;
  };
  eligibility: {
    citizenship: string | string[];
    passports?: string[];
    authorized_to_work: string[];
    requires_sponsorship_for: string[];
    remote_ready: boolean;
    proven_timezones: string[];
    overlap_evidence: string;
    /** Rendered on CVs for EU roles — recruiters screen hard on this. */
    eu_work_authorization_statement?: string;
    /** The cover-letter sentence on work authorization, per document language. */
    work_authorization_letter?: Partial<Record<"en" | "pt" | "es", string>>;
    declare_passport?: string;
    country_of_residence?: string;
  };
  languages: { language: string; level: string; certified: boolean }[];
  /**
   * Yes/no facts the candidate declared during onboarding. A fact left out is
   * never answered on their behalf.
   */
  declarations?: {
    veteran?: boolean;
    held_public_office?: boolean;
    relatives_at_target_companies?: boolean;
    worked_at_target_companies?: boolean;
  };
  education: EducationEntry[];
  certifications: Certification[];
  employment: EmploymentEntry[];
  skills: Record<SkillLevel, string[]>;
  gaps: Gap[];
}

export type Lang = "en" | "pt" | "es";

export interface Corpus {
  profile: Profile;
  claims: Claim[];
  /** Lowercased skill -> declared level, for the over-claim check. */
  skillLevels: Map<string, SkillLevel>;
  byId: Map<string, Claim>;
  /**
   * claim id -> canonical translations. A missing entry means that claim is
   * English-only, which forces the whole document back to English rather than
   * producing a half-translated CV.
   */
  translations: Map<string, Partial<Record<"pt" | "es", string>>>;
}

export class CorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusError";
  }
}
