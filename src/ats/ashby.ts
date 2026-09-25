/**
 * Ashby job-board adapter.
 *
 * Endpoint: https://api.ashbyhq.com/posting-api/job-board/{token}
 * Verified live against `ramp` (144 postings). An unknown token returns HTTP 404 with
 * a plain-text body, so the response is never assumed to be JSON on failure.
 *
 * Ashby ships both `descriptionHtml` and `descriptionPlain`; the plain variant is
 * preferred because Ashby renders it itself, and it needs no tag stripping.
 */

import { htmlToText } from './html.ts';
import { asRecord, fetchJson, readArray, readBoolean, readId, readString, toIsoTimestamp } from './http.ts';
import { classifyRemote } from './remote.ts';
import { AtsNotFoundError, type AtsAdapter, type NormalizedJob } from './types.ts';

function boardUrl(token: string): string {
  return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`;
}

/** Combine the primary location with any secondary locations into one raw string. */
function buildLocation(job: Record<string, unknown>): string {
  const locations: string[] = [];

  const primary = readString(job, 'location');
  if (primary !== undefined) locations.push(primary);

  for (const entry of readArray(job, 'secondaryLocations')) {
    const record = asRecord(entry);
    if (record === null) continue;
    const location = readString(record, 'location');
    if (location !== undefined && !locations.includes(location)) locations.push(location);
  }

  return locations.join(', ');
}

function normalize(raw: unknown, token: string, fetchedAt: string): NormalizedJob | null {
  const job = asRecord(raw);
  if (job === null) return null;

  // `isListed: false` postings are drafts or internal-only and must not enter the pipeline.
  if (readBoolean(job, 'isListed') === false) return null;

  const id = readId(job, 'id');
  const title = readString(job, 'title');
  const url = readString(job, 'jobUrl') ?? readString(job, 'applyUrl');
  if (id === undefined || title === undefined || url === undefined) return null;

  const locationRaw = buildLocation(job);
  const descriptionHtml = readString(job, 'descriptionHtml');
  const descriptionPlain = readString(job, 'descriptionPlain');
  const descriptionText = descriptionPlain ?? htmlToText(descriptionHtml ?? '');

  const normalized: NormalizedJob = {
    id,
    atsType: 'ashby',
    companyToken: token,
    title,
    url,
    locationRaw,
    remotePolicy: classifyRemote(locationRaw, descriptionText, {
      // workplaceType outranks isRemote: Ramp returns isRemote:true with
      // workplaceType:"Hybrid" on the same posting.
      workplaceType: readString(job, 'workplaceType'),
      isRemote: readBoolean(job, 'isRemote'),
    }),
    descriptionText,
    fetchedAt,
  };

  if (descriptionHtml !== undefined) normalized.descriptionHtml = descriptionHtml;

  const department = readString(job, 'team') ?? readString(job, 'department');
  if (department !== undefined) normalized.department = department;

  const employmentType = readString(job, 'employmentType');
  if (employmentType !== undefined) normalized.employmentType = employmentType;

  const compensation = asRecord(job['compensation']);
  const salaryRaw =
    compensation === null
      ? readString(job, 'compensationTierSummary')
      : readString(compensation, 'compensationTierSummary') ?? readString(compensation, 'summary');
  if (salaryRaw !== undefined) normalized.salaryRaw = salaryRaw;

  const postedAt = toIsoTimestamp(job['publishedAt'] ?? job['updatedAt']);
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

export const ashbyAdapter: AtsAdapter = { atsType: 'ashby', fetchJobs, probe };
