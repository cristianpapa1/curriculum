/**
 * ATS adapter registry and multi-target ingest.
 *
 * Scope boundary: discovery and ingest only. Nothing here submits an application.
 */

import { ashbyAdapter } from './ashby.ts';
import { greenhouseAdapter } from './greenhouse.ts';
import { leverAdapter } from './lever.ts';
import { smartRecruitersAdapter } from './smartrecruiters.ts';
import { workableAdapter } from './workable.ts';
import { gupyAdapter } from './gupy.ts';
import {
  AtsError,
  type AtsAdapter,
  type AtsFailure,
  type AtsTarget,
  type AtsType,
  type FetchAllOptions,
  type FetchAllReport,
  type NormalizedJob,
} from './types.ts';

export const adapters: Record<string, AtsAdapter> = {
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
  ashby: ashbyAdapter,
  workable: workableAdapter,
  smartrecruiters: smartRecruitersAdapter,
  gupy: gupyAdapter,
};

/**
 * Probe order for {@link detectAts}.
 *
 * SmartRecruiters is deliberately last: it answers HTTP 200 with an empty result set
 * for tokens that do not exist, so it can never disprove a token and would otherwise
 * mask a real match on an ATS that can.
 */
const DETECTION_ORDER: readonly AtsType[] = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'smartrecruiters',
];

const DEFAULT_CONCURRENCY = 4;

function toFailure(target: AtsTarget, error: unknown): AtsFailure {
  if (error instanceof AtsError) {
    const failure: AtsFailure = {
      token: target.token,
      atsType: target.atsType,
      message: error.message,
    };
    if (error.status !== undefined) failure.status = error.status;
    return failure;
  }

  return {
    token: target.token,
    atsType: target.atsType,
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Fetch every target, isolating failures.
 *
 * Runs at most `concurrency` targets in parallel (default 4). The shared HTTP layer
 * serializes requests per host on top of this, so parallelism never turns into
 * hammering a single job board. One bad target never fails the run: its error is
 * recorded in {@link FetchAllReport.failures}.
 */
export async function fetchAllWithReport(
  targets: readonly AtsTarget[],
  options: FetchAllOptions = {},
): Promise<FetchAllReport> {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const jobs: NormalizedJob[] = [];
  const failures: AtsFailure[] = [];

  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= targets.length) return;

      const target = targets[index];
      if (target === undefined) return;

      const adapter = adapters[target.atsType];
      if (adapter === undefined) {
        const failure: AtsFailure = {
          token: target.token,
          atsType: target.atsType,
          message: `unknown atsType "${target.atsType}"`,
        };
        failures.push(failure);
        options.onFailure?.(failure);
        continue;
      }

      try {
        const fetched = await adapter.fetchJobs(target.token);
        jobs.push(...fetched);
      } catch (error) {
        const failure = toFailure(target, error);
        failures.push(failure);
        options.onFailure?.(failure);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(targets.length, 1)) }, () => worker()),
  );

  return { jobs, failures };
}

/**
 * Fetch every target and return the jobs that succeeded.
 *
 * Never throws because one target failed. Use `options.onFailure` — or
 * {@link fetchAllWithReport} — when the failures matter to the caller.
 */
export async function fetchAll(
  targets: readonly AtsTarget[],
  options: FetchAllOptions = {},
): Promise<NormalizedJob[]> {
  const report = await fetchAllWithReport(targets, options);
  return report.jobs;
}

/**
 * Identify which ATS hosts `token`, by probing each in {@link DETECTION_ORDER}.
 *
 * Returns the first ATS reporting at least one posting, or `null` when none do.
 * Probes run sequentially: a detection sweep is a courtesy query against five
 * unrelated vendors, and there is no reason to fan out.
 *
 * Note the deliberate limit — a board that exists but currently has zero open roles is
 * indistinguishable from a token that does not exist, so it yields `null`.
 */
export async function detectAts(token: string): Promise<string | null> {
  for (const atsType of DETECTION_ORDER) {
    const adapter = adapters[atsType];
    if (adapter === undefined) continue;
    if (await adapter.probe(token)) return atsType;
  }
  return null;
}

export { htmlToText } from './html.ts';
export { classifyRemote, isBrazilEligible } from './remote.ts';
export type { RemoteHints } from './remote.ts';
export { createSmartRecruitersAdapter } from './smartrecruiters.ts';
export type { SmartRecruitersOptions } from './smartrecruiters.ts';
export {
  AtsError,
  AtsNotFoundError,
  type AtsAdapter,
  type AtsFailure,
  type AtsTarget,
  type AtsType,
  type BrazilEligibility,
  type FetchAllOptions,
  type FetchAllReport,
  type NormalizedJob,
  type RemotePolicy,
} from './types.ts';
