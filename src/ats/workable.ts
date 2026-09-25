/**
 * Workable job-widget adapter.
 *
 * Endpoint: https://apply.workable.com/api/v1/widget/accounts/{token}?details=true
 * Verified live: the envelope is `{name, description, jobs: []}` and an unknown token
 * returns HTTP 404 with the plain-text body "Not Found".
 *
 * Caveat, stated honestly: every account reachable at build time (hotjar, cabify,
 * unbabel, talkdesk, outsystems, farfetch, revolut-1, doist) returned `jobs: []`, so
 * the per-posting field mapping below is written against Workable's documented widget
 * shape and exercised by fixtures in test/ats.test.ts, not against a live payload.
 * Both the flat (`city`/`country`) and nested (`location: {...}`) location layouts are
 * accepted because the widget has shipped both.
 */

import { htmlToText } from './html.ts';
import { asRecord, fetchJson, readArray, readBoolean, readId, readRecord, readString, toIsoTimestamp } from './http.ts';
import { classifyRemote } from './remote.ts';
import { AtsNotFoundError, type AtsAdapter, type NormalizedJob } from './types.ts';

function boardUrl(token: string): string {
  return `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(token)}?details=true`;
}

/** Build a location string from either the nested or the flat field layout. */
function buildLocation(job: Record<string, unknown>): string {
  const nested = readRecord(job, 'location');
  const source = nested ?? job;

  const parts = [
    readString(source, 'city'),
    readString(source, 'region') ?? readString(source, 'state'),
    readString(source, 'country'),
  ].filter((part): part is string => part !== undefined);

  const location = parts.join(', ');
  const telecommuting =
    readBoolean(job, 'telecommuting') ?? readBoolean(source, 'telecommuting') ?? false;

  if (!telecommuting) return location;
  return location.length > 0 ? `Remote - ${location}` : 'Remote';
}

/** Workable splits the posting across description/requirements/benefits. */
function buildDescriptionHtml(job: Record<string, unknown>): string | undefined {
  const parts = [
    readString(job, 'description'),
    readString(job, 'requirements'),
    readString(job, 'benefits'),
  ].filter((part): part is string => part !== undefined);

  return parts.length > 0 ? parts.join('\n') : undefined;
}

function normalize(raw: unknown, token: string, fetchedAt: string): NormalizedJob | null {
  const job = asRecord(raw);
  if (job === null) return null;

  // Only live postings belong in the pipeline; drafts and archived roles are skipped.
  const state = readString(job, 'state');
  if (state !== undefined && state.toLowerCase() !== 'published') return null;

  const id = readId(job, 'shortcode') ?? readId(job, 'id') ?? readId(job, 'code');
  const title = readString(job, 'title') ?? readString(job, 'full_title');
  const url = readString(job, 'url') ?? readString(job, 'shortlink') ?? readString(job, 'application_url');
  if (id === undefined || title === undefined || url === undefined) return null;

  const locationRaw = buildLocation(job);
  const descriptionHtml = buildDescriptionHtml(job);
  const descriptionText = htmlToText(descriptionHtml ?? '');

  const normalized: NormalizedJob = {
    id,
    atsType: 'workable',
    companyToken: token,
    title,
    url,
    locationRaw,
    remotePolicy: classifyRemote(locationRaw, descriptionText, {
      isRemote: readBoolean(job, 'telecommuting'),
      workplaceType: readString(job, 'workplace_type'),
    }),
    descriptionText,
    fetchedAt,
  };

  if (descriptionHtml !== undefined) normalized.descriptionHtml = descriptionHtml;

  const department = readString(job, 'department');
  if (department !== undefined) normalized.department = department;

  const employmentType = readString(job, 'employment_type');
  if (employmentType !== undefined) normalized.employmentType = employmentType;

  const salaryRaw = readString(job, 'salary') ?? readString(job, 'salary_range');
  if (salaryRaw !== undefined) normalized.salaryRaw = salaryRaw;

  const postedAt = toIsoTimestamp(job['published_on'] ?? job['created_at']);
  if (postedAt !== undefined) normalized.postedAt = postedAt;

  return normalized;
}

async function fetchJobs(token: string): Promise<NormalizedJob[]> {
  let payload: unknown;
  try {
    payload = await fetchJson(boardUrl(token));
  } catch (error) {
    if (error instanceof AtsNotFoundError) return [];
    throw error;
  }

  const root = asRecord(payload);
  if (root === null) return [];

  const fetchedAt = new Date().toISOString();
  return readArray(root, 'jobs')
    .map((entry) => normalize(entry, token, fetchedAt))
    .filter((job): job is NormalizedJob => job !== null);
}

async function probe(token: string): Promise<boolean> {
  try {
    const payload = await fetchJson(boardUrl(token));
    const root = asRecord(payload);
    return root !== null && readArray(root, 'jobs').length > 0;
  } catch {
    return false;
  }
}

export const workableAdapter: AtsAdapter = { atsType: 'workable', fetchJobs, probe };
