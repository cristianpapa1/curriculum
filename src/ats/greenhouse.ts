/**
 * Greenhouse job-board adapter.
 *
 * Endpoint: https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
 * Verified live against `stripe` (628 postings). `content` arrives entity-escaped;
 * {@link htmlToText} owns that decoding. `metadata` is frequently `null`.
 */

import { htmlToText } from './html.ts';
import { asRecord, fetchJson, readArray, readId, readRecord, readString, toIsoTimestamp } from './http.ts';
import { classifyRemote } from './remote.ts';
import { AtsNotFoundError, type AtsAdapter, type NormalizedJob } from './types.ts';

const BASE_URL = 'https://boards-api.greenhouse.io/v1/boards';

function boardUrl(token: string): string {
  return `${BASE_URL}/${encodeURIComponent(token)}/jobs?content=true`;
}

/** Join every department name; Greenhouse nests departments as an array of objects. */
function readDepartment(job: Record<string, unknown>): string | undefined {
  const names = readArray(job, 'departments')
    .map((entry) => {
      const record = asRecord(entry);
      return record === null ? undefined : readString(record, 'name');
    })
    .filter((name): name is string => name !== undefined);

  return names.length > 0 ? names.join(', ') : undefined;
}

/**
 * Greenhouse exposes compensation through free-form board metadata when the board
 * is configured for it. Values may be strings or arrays of strings.
 */
function readSalary(job: Record<string, unknown>): string | undefined {
  for (const entry of readArray(job, 'metadata')) {
    const record = asRecord(entry);
    if (record === null) continue;

    const name = readString(record, 'name');
    if (name === undefined || !/salary|compensation|pay|comp range/i.test(name)) continue;

    const value = record['value'];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (Array.isArray(value)) {
      const parts = value.filter((item): item is string => typeof item === 'string');
      if (parts.length > 0) return parts.join(', ');
    }
  }
  return undefined;
}

function normalize(raw: unknown, token: string, fetchedAt: string): NormalizedJob | null {
  const job = asRecord(raw);
  if (job === null) return null;

  const id = readId(job, 'id');
  const title = readString(job, 'title');
  const url = readString(job, 'absolute_url');
  // A posting without an id, title or URL cannot be applied to or de-duplicated,
  // so it is dropped rather than emitted in a broken state.
  if (id === undefined || title === undefined || url === undefined) return null;

  const locationRaw = readString(readRecord(job, 'location') ?? {}, 'name') ?? '';
  const contentHtml = readString(job, 'content');
  const descriptionText = htmlToText(contentHtml ?? '');

  const normalized: NormalizedJob = {
    id,
    atsType: 'greenhouse',
    companyToken: token,
    title,
    url,
    locationRaw,
    remotePolicy: classifyRemote(locationRaw, descriptionText),
    descriptionText,
    fetchedAt,
  };

  if (contentHtml !== undefined) normalized.descriptionHtml = contentHtml;

  const department = readDepartment(job);
  if (department !== undefined) normalized.department = department;

  const salaryRaw = readSalary(job);
  if (salaryRaw !== undefined) normalized.salaryRaw = salaryRaw;

  const postedAt = toIsoTimestamp(job['updated_at'] ?? job['first_published']);
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
    // probe() answers a yes/no question; transport failures and 404s are both "no".
    return false;
  }
}

export const greenhouseAdapter: AtsAdapter = { atsType: 'greenhouse', fetchJobs, probe };
