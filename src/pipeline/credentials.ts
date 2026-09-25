/**
 * Applicant credentials.
 *
 * Used when a portal requires an account.
 * They live in `.env` (chmod 600, gitignored) and are read only at the moment
 * of use — never written into an application folder, a log line, the ledger or
 * a note.
 *
 * Two rules this module enforces mechanically:
 *   1. The password is never returned by any function that produces display or
 *      log output. `describe()` exists so callers have a safe thing to print.
 *   2. A missing credential is a clear error naming the variable, not an
 *      `undefined` that silently fills a form field with "undefined".
 *
 * Worth knowing: of the five ATS platforms this pipeline supports — Greenhouse,
 * Lever, Ashby, Workable and SmartRecruiters — none requires an account to
 * apply. They accept a one-shot form with name, email and an attached CV.
 * Accounts are required mainly by Workday, iCIMS, Taleo and LinkedIn, none of
 * which has an adapter yet. So these credentials are infrastructure for the
 * portals that come next, not something the current pipeline reaches for.
 */

import { join, resolve } from "node:path";
import { PROJECT_ROOT } from "../corpus/load.ts";

/** `CURRICULUM_ENV_FILE` overrides it — the tests point it at a fictional fixture. */
export const ENV_PATH = process.env.CURRICULUM_ENV_FILE
  ? resolve(process.env.CURRICULUM_ENV_FILE)
  : join(PROJECT_ROOT, ".env");

export interface ApplicantIdentity {
  email: string;
  fullName: string;
  phone: string;
  location: string;
  /** Brazilian CPF — only typed into Brazilian forms that require it. Never logged. */
  cpf: string;
  /**
   * Postal address, for the few forms that demand one (an "Address Line 1" and
   * a postal code). Reported masked, like the national ID.
   */
  address: { street: string; district: string; city: string; state: string; postal: string; country: string };
  github: string;
  website: string;
  linkedin: string;
}

export interface ApplicantCredentials extends ApplicantIdentity {
  /** Only ever read at the point of form submission. Never logged. */
  password: string;
}

let cached: Record<string, string> | null = null;

async function readEnv(): Promise<Record<string, string>> {
  if (cached) return cached;

  const file = Bun.file(ENV_PATH);
  if (!(await file.exists())) {
    // Fall back to the process environment so CI or a shell export also works.
    cached = { ...process.env } as Record<string, string>;
    return cached;
  }

  const out: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const raw of (await file.text()).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key) out[key] = value;
  }
  cached = out;
  return out;
}

function required(env: Record<string, string>, key: string): string {
  const v = env[key];
  if (!v || v.trim() === "") {
    throw new Error(
      `missing ${key} — set it in ${ENV_PATH} (copy .env.example) or export it`,
    );
  }
  return v.trim();
}

/**
 * Identity fields, without the password. Name, email and links are safe to log;
 * the CPF and the postal address are not — reports print them masked.
 */
export async function loadIdentity(): Promise<ApplicantIdentity> {
  const env = await readEnv();
  return {
    email: required(env, "APPLICANT_EMAIL"),
    fullName: required(env, "APPLICANT_FULL_NAME"),
    phone: env.APPLICANT_PHONE?.trim() ?? "",
    location: env.APPLICANT_LOCATION?.trim() ?? "",
    cpf: (env.APPLICANT_CPF ?? "").replace(/\D/g, ""),
    address: {
      street: env.APPLICANT_ADDRESS_STREET?.trim() ?? "",
      district: env.APPLICANT_ADDRESS_DISTRICT?.trim() ?? "",
      city: env.APPLICANT_ADDRESS_CITY?.trim() ?? "",
      state: env.APPLICANT_ADDRESS_STATE?.trim() ?? "",
      postal: env.APPLICANT_ADDRESS_POSTAL?.trim() ?? "",
      country: env.APPLICANT_ADDRESS_COUNTRY?.trim() ?? "",
    },
    github: env.APPLICANT_GITHUB?.trim() ?? "",
    website: env.APPLICANT_WEBSITE?.trim() ?? "",
    linkedin: env.APPLICANT_LINKEDIN?.trim() ?? "",
  };
}

/**
 * Full credentials including the password. Call this ONLY at the moment a
 * portal's sign-in or sign-up form is being filled.
 */
export async function loadCredentials(): Promise<ApplicantCredentials> {
  const env = await readEnv();
  return {
    ...(await loadIdentity()),
    // Optional: only portals that force an account (Workday, iCIMS…) need it, and
    // none has an adapter yet. Empty rather than an error, so a new user is not
    // blocked on a password nothing reads.
    password: env.APPLICANT_PASSWORD?.trim() ?? "",
  };
}

/** A printable summary that can never leak the password. */
export function describe(c: ApplicantIdentity | ApplicantCredentials): string {
  const hasPassword = "password" in c && Boolean(c.password);
  return `${c.fullName} <${c.email}>${hasPassword ? " [password: set, redacted]" : ""}`;
}

/**
 * Strip the password out of any string before it reaches a log, a screenshot
 * caption, an error message or the ledger.
 */
export async function redact(text: string): Promise<string> {
  const env = await readEnv();
  const secret = env.APPLICANT_PASSWORD;
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join("«redacted»");
}

/** Platforms that force an account before you can apply. */
const REQUIRES_ACCOUNT: Record<string, boolean> = {
  greenhouse: false,
  lever: false,
  ashby: false,
  workable: false,
  smartrecruiters: false,
  workday: true,
  icims: true,
  taleo: true,
  successfactors: true,
  linkedin: true,
};

export function requiresAccount(atsType: string): boolean {
  return REQUIRES_ACCOUNT[atsType.toLowerCase()] ?? false;
}

/** Which supported platforms would need sign-in for a given set of targets. */
export function accountsNeededFor(atsTypes: string[]): string[] {
  return [...new Set(atsTypes.filter(requiresAccount))];
}

// `bun run src/pipeline/credentials.ts` — confirm wiring without printing secrets.
if (import.meta.main) {
  const id = await loadIdentity();
  console.log("identity:", describe(id));
  try {
    const full = await loadCredentials();
    console.log("credentials:", describe(full));
    console.log("redaction check:", await redact(`token=${full.password};`));
  } catch (err) {
    console.log("credentials:", (err as Error).message);
  }
  console.log("\naccount required per platform:");
  for (const [ats, needs] of Object.entries(REQUIRES_ACCOUNT)) {
    console.log(`  ${ats.padEnd(16)} ${needs ? "yes" : "no"}`);
  }
}
