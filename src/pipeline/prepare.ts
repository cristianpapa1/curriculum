/**
 * The prepare pipeline: discover → filter → dedupe → score → tailor → file.
 *
 * Everything up to and including document generation happens here. Submission
 * is deliberately a separate step (Interceptor, real Chrome, host-side), so a
 * prepared application is a complete, inspectable artifact that has not yet
 * been sent anywhere.
 *
 * Failure isolation is the rule: a posting that fails the anti-fabrication
 * gate, fails rendering, or fails PDF generation is skipped with a recorded
 * reason and the run continues to the next posting (ISC-17). One bad posting
 * must never take down a run.
 */

import { join } from "node:path";
import type { Corpus } from "../corpus/types.ts";
import type { NormalizedJob } from "../ats/types.ts";
import { adapters } from "../ats/index.ts";
import { isBrazilEligible } from "../ats/remote.ts";
import { classifyEligibility, type EligibilityPath } from "./eligibility.ts";
import { chooseLocale } from "../render/locale.ts";
import { checkLanguages } from "./languages.ts";
import { checkFit } from "./fit.ts";
import { isEntryLevel, withinTargetLevel } from "./level.ts";
import { postingSignals } from "./certifications.ts";
import { renderCV } from "../render/cv.ts";
import { renderLetter } from "../render/letter.ts";
import { htmlToPdf } from "../render/pdf.ts";
import { checkAntiFabrication, formatViolations } from "../position/antifab.ts";
import { scoreJob, type JobScore } from "./score.ts";
import {
  recordApplication,
  alreadyApplied,
  loadApplications,
  folderName,
  cvFileBase,
  type ApplicationMeta,
} from "../ledger/ledger.ts";

export interface Target {
  atsType: string;
  token: string;
  /** Display name; falls back to the token. */
  company?: string;
}

export interface PrepareOptions {
  /** Positioning angle. Omit to let each posting's own best-fit angle win. */
  angle?: string | null;
  /** Minimum match score to prepare an application. */
  minScore?: number;
  /** Cap applications prepared in one run. */
  limit?: number;
  /** Skip the eligibility filter (for inspection runs). */
  ignoreEligibility?: boolean;
  /** Which eligibility paths to accept. Default: remote only. */
  paths?: EligibilityPath[];
  /** Force a document language instead of deriving it from the posting. */
  lang?: "en" | "pt" | "es";
  /**
   * Only consider postings whose title matches. A board can carry hundreds of
   * roles and ranking by score alone buries the specific one being targeted.
   */
  titleMatch?: string;
  /**
   * Max applications per company in one run, counting ones already on file.
   * Boards differ wildly in size — one board alone can have hundreds of eligible
   * roles — and several cap applications per candidate (one board allows 3 per 60
   * days). Without a cap a batch collapses onto two or three employers.
   */
  perCompanyCap?: number;
  /** Include roles that need a work visa (UK, US). Off by default. */
  allowSponsorship?: boolean;
  /** Skip postings outside the candidate's level by field (level.ts). Off by default. */
  focusOnly?: boolean;
  /** Only entry-level titles on the US path (junior / intern / new grad / "I"). */
  usEntryLevelOnly?: boolean;
  /** Generate PDFs. Off makes dry runs fast. */
  pdf?: boolean;
  applicationsDir?: string;
  ledgerFile?: string;
}

export interface SkipReason {
  job: string;
  company: string;
  reason: string;
}

export interface PrepareResult {
  prepared: { dir: string; meta: ApplicationMeta; score: JobScore }[];
  skipped: SkipReason[];
  fetched: number;
  errors: string[];
}

export async function prepareApplications(
  corpus: Corpus,
  targets: Target[],
  options: PrepareOptions = {},
): Promise<PrepareResult> {
  const opts = {
    minScore: 0,
    limit: 10,
    pdf: true,
    ignoreEligibility: false,
    ...options,
  };

  const result: PrepareResult = { prepared: [], skipped: [], fetched: 0, errors: [] };

  // ── Discover ──────────────────────────────────────────────────────────
  const jobs: NormalizedJob[] = [];
  for (const t of targets) {
    const adapter = adapters[t.atsType];
    if (!adapter) {
      result.errors.push(`unknown ATS "${t.atsType}" for ${t.token}`);
      continue;
    }
    try {
      const fetched = await adapter.fetchJobs(t.token);
      jobs.push(...fetched);
    } catch (err) {
      result.errors.push(`${t.atsType}:${t.token} — ${(err as Error).message}`);
    }
  }
  result.fetched = jobs.length;

  // ── Filter, score, rank ───────────────────────────────────────────────
  const titleRe = opts.titleMatch ? new RegExp(opts.titleMatch, "i") : null;

  const candidates: { job: NormalizedJob; score: JobScore }[] = [];
  for (const job of jobs) {
    if (titleRe && !titleRe.test(job.title)) continue;
    if (!opts.ignoreEligibility) {
      const elig = classifyEligibility(job);
      if (!elig.eligible) continue; // quiet: this is the common case, not an error
      const accepted = opts.paths ?? ["remote-brazil-eligible"];
      if (!accepted.includes(elig.path)) {
        // Relocation roles are real but belong in their own lane — including
        // them by default would quietly distort the remote response rate.
        result.skipped.push({
          job: job.title,
          company: job.companyToken,
          reason: `${elig.path} not in accepted paths (${accepted.join(", ")})`,
        });
        continue;
      }
      // Sponsorship-required roles are opt-in, wherever they are. The US lane
      // already was; the UK slipped through inside "relocation-europe" and put
      // twelve visa-dependent roles into a batch meant for review.
      // Visa-dependent roles for entry-level titles only: sponsorship is rarely
      // granted above entry level. That holds wherever a visa is needed — the UK
      // too since Brexit, whose roles otherwise arrive inside the Europe lane.
      if (elig.requiresSponsorship && opts.usEntryLevelOnly && !isEntryLevel(job.title)) {
        result.skipped.push({ job: job.title, company: job.companyToken, reason: "needs a work visa and is above entry level — sponsored roles are junior-only" });
        continue;
      }
      if (elig.requiresSponsorship && !opts.allowSponsorship && !accepted.includes("relocation-us")) {
        result.skipped.push({
          job: job.title,
          company: job.companyToken,
          reason: `requires visa sponsorship (${elig.reason}) — opt in with --allow-sponsorship`,
        });
        continue;
      }
    }

    // Level, languages named in the title, and the language the posting is
    // written in — the checks a recruiter makes before reading anything else.
    const fit = checkFit(corpus, job);
    if (!fit.ok) {
      result.skipped.push({ job: job.title, company: job.companyToken, reason: `fit/${fit.check}: ${fit.reason}` });
      continue;
    }

    // The candidate's own level by field (level.ts). A filter only with
    // --focus-only: by default volume comes first, and the focus orders the
    // manual index instead of excluding anything.
    const target = withinTargetLevel(job.title);
    if (opts.focusOnly && !target.ok) {
      result.skipped.push({ job: job.title, company: job.companyToken, reason: `level: ${target.reason}` });
      continue;
    }

    // A posting that explicitly demands a spoken language the candidate does not
    // have is unwinnable, and applying anyway reads as posing as a speaker.
    const langCheck = checkLanguages(corpus, job.title, job.descriptionText);
    if (!langCheck.ok) {
      result.skipped.push({
        job: job.title,
        company: job.companyToken,
        reason: langCheck.reason,
      });
      continue;
    }

    const score = scoreJob(corpus, job, opts.angle ?? null);
    if (score.score < opts.minScore) {
      result.skipped.push({
        job: job.title,
        company: job.companyToken,
        reason: `score ${score.score} below minimum ${opts.minScore}`,
      });
      continue;
    }
    candidates.push({ job, score });
  }
  candidates.sort((a, b) => b.score.score - a.score.score);

  // ── Tailor and file ───────────────────────────────────────────────────
  // Seed the per-company count with applications already on file.
  const cap = opts.perCompanyCap ?? 3;
  const perCompany = new Map<string, number>();
  for (const a of await loadApplications(opts.applicationsDir)) {
    const k = a.company.toLowerCase();
    perCompany.set(k, (perCompany.get(k) ?? 0) + 1);
  }

  for (const { job, score } of candidates) {
    if (result.prepared.length >= opts.limit) break;
    const companyKey = prettyCompany(job.companyToken).toLowerCase();
    if ((perCompany.get(companyKey) ?? 0) >= cap) continue;

    try {
      const prior = await alreadyApplied(job.atsType, job.id, opts.applicationsDir);
      if (prior) {
        result.skipped.push({
          job: job.title,
          company: job.companyToken,
          reason: `already applied ${prior.preparedAt.slice(0, 10)} (${prior.status})`,
        });
        continue;
      }

      const angle = opts.angle ?? score.suggestedAngle;
      const company = prettyCompany(job.companyToken);

      // Language follows the posting's region: Brazil → pt, Spanish-speaking
      // LATAM → es, everything else → en.
      const locale = opts.lang ? { lang: opts.lang, reason: "forced by operator" } : chooseLocale(job);

      const elig = classifyEligibility(job);
      // Requirements the posting names AND the candidate actually has. These lead
      // the skills block and are never trimmed — the ATS scores on the
      // posting own keywords, not on our taxonomy.
      const requiredSkills = score.matches
        .filter((m) => m.matched)
        .map((m) => m.term);

      // EU roles: lead with the fact that no sponsorship is needed.
      const showWorkAuthorization = elig.path === "relocation-europe" && !elig.requiresSponsorship;
      const cv = renderCV(corpus, angle, {
        targetTitle: job.title,
        lang: locale.lang,
        showWorkAuthorization,
        requiredSkills,
        requirements: score.matches,
        postingSignals: postingSignals(job.title, score.matches.map((m) => m.term)),
      });
      const letter = renderLetter(corpus, angle, {
        company,
        roleTitle: job.title,
        locationRaw: job.locationRaw,
        lang: locale.lang,
        requirements: score.matches,
        showWorkAuthorization,
        postingSignals: postingSignals(job.title, score.matches.map((m) => m.term)),
      });

      // ── The guard. Blocks THIS application only. ──────────────────────
      for (const [label, doc] of [["CV", cv], ["cover letter", letter]] as const) {
        const gate = checkAntiFabrication(doc.markdown, corpus);
        if (!gate.ok) {
          throw new Error(
            `anti-fabrication gate rejected the ${label}:\n${formatViolations(gate.violations)}`,
          );
        }
      }

      const preparedAt = new Date().toISOString();
      const dirName = folderName({ preparedAt, company, roleTitle: job.title });
      const cvName = cvFileBase(dirName, corpus.profile.identity.name);

      const files: { name: string; content: string | Uint8Array }[] = [
        { name: `${cvName}.md`, content: cv.markdown },
        { name: `${cvName}.html`, content: cv.html },
        { name: "CoverLetter.md", content: letter.markdown },
        { name: "CoverLetter.html", content: letter.html },
        { name: "job-description.md", content: jobSnapshot(job, score) },
        { name: "match-report.json", content: JSON.stringify(score, null, 2) },
      ];

      const meta: ApplicationMeta = {
        id: `${job.atsType}:${job.id}`,
        atsType: job.atsType,
        jobId: job.id,
        company,
        roleTitle: job.title,
        url: job.url,
        angle: angle ?? null,
        score: score.score,
        claimIds: [...new Set([...cv.claimIds, ...letter.claimIds])],
        locationRaw: job.locationRaw,
        remotePolicy: job.remotePolicy,
        brazilEligible: classifyEligibility(job).eligible,
        eligibilityReason: classifyEligibility(job).reason,
        eligibilityPath: classifyEligibility(job).path,
        requiresSponsorship: classifyEligibility(job).requiresSponsorship,
        lang: cv.lang,
        langReason: cv.langFallbackReason ?? locale.reason,
        preparedAt,
        submittedAt: null,
        status: "prepared",
        cvFile: `${cvName}.pdf`,
        letterFile: "CoverLetter.pdf",
        jobDescriptionFile: "job-description.md",
        proofFile: null,
        respondedAt: null,
        responseType: null,
        followUpDue: null,
        notes: [],
      };

      const dir = await recordApplication(meta, files, {
        applicationsDir: opts.applicationsDir,
        ledgerFile: opts.ledgerFile,
      });

      // PDFs after the folder exists, so a PDF failure cannot orphan a record.
      if (opts.pdf) {
        try {
          await htmlToPdf(cv.html, join(dir, `${cvName}.pdf`));
          await htmlToPdf(letter.html, join(dir, "CoverLetter.pdf"));
        } catch (err) {
          result.errors.push(
            `${company} / ${job.title}: PDF generation failed — ${(err as Error).message}`,
          );
        }
      }

      result.prepared.push({ dir, meta, score });
      perCompany.set(companyKey, (perCompany.get(companyKey) ?? 0) + 1);
    } catch (err) {
      // Isolation: record and continue (ISC-17).
      result.skipped.push({
        job: job.title,
        company: job.companyToken,
        reason: (err as Error).message.split("\n")[0] ?? String(err),
      });
    }
  }

  return result;
}

function prettyCompany(token: string): string {
  return token
    .split(/[-_]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

function jobSnapshot(job: NormalizedJob, score: JobScore): string {
  const elig = isBrazilEligible(job);
  return [
    `# ${job.title}`,
    ``,
    `- **Company token:** ${job.companyToken}`,
    `- **ATS:** ${job.atsType} (job id ${job.id})`,
    `- **URL:** ${job.url}`,
    `- **Location:** ${job.locationRaw}`,
    `- **Remote policy:** ${job.remotePolicy}`,
    `- **Brazil eligible:** ${elig.eligible} — ${elig.reason}`,
    `- **Match score:** ${score.score}/100 (${score.matchedCount}/${score.totalCount} requirements evidenced)`,
    `- **Suggested angle:** ${score.suggestedAngle ?? "none"}`,
    `- **Captured:** ${new Date().toISOString()}`,
    ``,
    score.gaps.length > 0
      ? `**Requirements with no corpus evidence:** ${score.gaps.join(", ")}\n`
      : `**All detected requirements are evidenced.**\n`,
    `---`,
    ``,
    job.descriptionText,
  ].join("\n");
}
