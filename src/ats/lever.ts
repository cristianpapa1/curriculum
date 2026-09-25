/**
 * Lever postings adapter.
 *
 * Endpoint: https://api.lever.co/v0/postings/{token}?mode=json
 * Verified live: `leverdemo` returns a bare JSON array (13 postings); an unknown token
 * returns HTTP 404 `{"ok":false,"error":"Document not found"}`; a live-but-empty board
 * (`mistral`) returns HTTP 200 `[]`. `createdAt` is epoch milliseconds.
 */

import { htmlToText } from './html.ts';
import { asRecord, fetchJson, readArray, readId, readRecord, readString, toIsoTimestamp } from './http.ts';
import { classifyRemote } from './remote.ts';
import { AtsNotFoundError, type AtsAdapter, type NormalizedJob } from './types.ts';

function boardUrl(token: string): string {
  return `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`;
}

/**
 * Lever splits a description across several fields. Concatenating them is what makes
 * eligibility screening reliable — restrictions often live in `lists` or `additional`,
 * not in the opening description.
 */
function buildDescription(job: Record<string, unknown>): { text: string; html?: string } {
  const htmlParts: string[] = [];

  const description = readString(job, 'description');
  if (description !== undefined) htmlParts.push(description);

  for (const entry of readArray(job, 'lists')) {
    const list = asRecord(entry);
    if (list === null) continue;
    const heading = readString(list, 'text');
    const content = readString(list, 'content');
    if (heading !== undefined) htmlParts.push(`<h3>${heading}</h3>`);
    if (content !== undefined) htmlParts.push(`<ul>${content}</ul>`);
  }

  const additional = readString(job, 'additional');
  if (additional !== undefined) htmlParts.push(additional);

  if (htmlParts.length > 0) {
    const html = htmlParts.join('\n');
    return { text: htmlToText(html), html };
  }

  // Fall back to Lever's pre-rendered plain text when no HTML variant was published.
  const plainParts = [readString(job, 'descriptionPlain'), readString(job, 'additionalPlain')]
    .filter((part): part is string => part !== undefined);

  return { text: plainParts.join('\n\n').trim() };
}

function normalize(raw: unknown, token: string, fetchedAt: string): NormalizedJob | null {
  const job = asRecord(raw);
  if (job === null) return null;

  const id = readId(job, 'id');
  const title = readString(job, 'text');
  const url = readString(job, 'hostedUrl') ?? readString(job, 'applyUrl');
  if (id === undefined || title === undefined || url === undefined) return null;

  const categories = readRecord(job, 'categories') ?? {};
  const allLocations = readArray(categories, 'allLocations')
    .filter((entry): entry is string => typeof entry === 'string');
  const locationRaw =
    allLocations.length > 0
      ? allLocations.join(', ')
      : readString(categories, 'location') ?? '';

  const { text: descriptionText, html: descriptionHtml } = buildDescription(job);

  const normalized: NormalizedJob = {
    id,
    atsType: 'lever',
    companyToken: token,
    title,
    url,
    locationRaw,
    remotePolicy: classifyRemote(locationRaw, descriptionText, {
      workplaceType: readString(job, 'workplaceType'),
    }),
    descriptionText,
    fetchedAt,
  };

  if (descriptionHtml !== undefined) normalized.descriptionHtml = descriptionHtml;

  const department = readString(categories, 'team') ?? readString(categories, 'department');
  if (department !== undefined) normalized.department = department;

  const employmentType = readString(categories, 'commitment');
  if (employmentType !== undefined) normalized.employmentType = employmentType;

  const salaryRaw = readString(job, 'salaryRange') ?? readString(categories, 'compensation');
  if (salaryRaw !== undefined) normalized.salaryRaw = salaryRaw;

  const postedAt = toIsoTimestamp(job['createdAt']);
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

  if (!Array.isArray(payload)) return [];

  const fetchedAt = new Date().toISOString();
  return payload
    .map((entry) => normalize(entry, token, fetchedAt))
    .filter((job): job is NormalizedJob => job !== null);
}

async function probe(token: string): Promise<boolean> {
  try {
    const payload = await fetchJson(boardUrl(token));
    return Array.isArray(payload) && payload.length > 0;
  } catch {
    return false;
  }
}

export const leverAdapter: AtsAdapter = { atsType: 'lever', fetchJobs, probe };
