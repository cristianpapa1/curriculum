/**
 * SmartRecruiters postings adapter.
 *
 * Endpoints:
 *   list:   https://api.smartrecruiters.com/v1/companies/{token}/postings?offset&limit
 *   detail: https://api.smartrecruiters.com/v1/companies/{token}/postings/{id}
 *
 * Two live-verified facts drive this design (probed against `BoschGroup`, 4843 postings):
 *
 * 1. The list endpoint carries NO description and NO posting URL. Only the detail
 *    endpoint returns `postingUrl` and `jobAd.sections.*`. Descriptions therefore cost
 *    one request per posting, which is why enrichment is bounded by `detailLimit`
 *    rather than run across the whole board.
 * 2. An unknown company returns HTTP 200 `{"totalFound":0,"content":[]}` — byte-identical
 *    to a real company with no open roles. SmartRecruiters can never report "token not
 *    found", so `probe` answers on posting count alone and the registry orders this
 *    adapter last during `detectAts`.
 */

import { htmlToText } from './html.ts';
import { asRecord, fetchJson, readArray, readBoolean, readId, readRecord, readString, toIsoTimestamp } from './http.ts';
import { classifyRemote } from './remote.ts';
import { AtsNotFoundError, type AtsAdapter, type NormalizedJob } from './types.ts';

const PAGE_SIZE = 100;

export interface SmartRecruitersOptions {
  /**
   * How many postings get a description fetched, newest first.
   * Each one is a separate serialized request, so the default keeps a full-board
   * ingest to a bounded cost. Postings past the limit are still returned, with an
   * empty `descriptionText`.
   */
  detailLimit?: number;
  /** Hard ceiling on postings pulled from the list endpoint. */
  maxPostings?: number;
}

const DEFAULT_OPTIONS: Required<SmartRecruitersOptions> = {
  detailLimit: 50,
  maxPostings: 1_000,
};

function listUrl(token: string, offset: number, limit: number): string {
  return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?offset=${offset}&limit=${limit}`;
}

function detailUrl(token: string, id: string): string {
  return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings/${encodeURIComponent(id)}`;
}

/** Concatenate every jobAd section into one HTML blob. */
function buildDetailHtml(detail: Record<string, unknown>): string | undefined {
  const sections = readRecord(readRecord(detail, 'jobAd') ?? {}, 'sections');
  if (sections === null) return undefined;

  const parts: string[] = [];
  for (const key of ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']) {
    const section = readRecord(sections, key);
    if (section === null) continue;
    const title = readString(section, 'title');
    const text = readString(section, 'text');
    if (text === undefined) continue;
    if (title !== undefined) parts.push(`<h3>${title}</h3>`);
    parts.push(text);
  }

  return parts.length > 0 ? parts.join('\n') : undefined;
}

function normalizeListEntry(raw: unknown, token: string, fetchedAt: string): NormalizedJob | null {
  const posting = asRecord(raw);
  if (posting === null) return null;

  const id = readId(posting, 'id');
  const title = readString(posting, 'name');
  if (id === undefined || title === undefined) return null;

  const location = readRecord(posting, 'location') ?? {};
  const locationRaw =
    readString(location, 'fullLocation') ??
    [readString(location, 'city'), readString(location, 'region'), readString(location, 'country')]
      .filter((part): part is string => part !== undefined)
      .join(', ');

  const normalized: NormalizedJob = {
    id,
    atsType: 'smartrecruiters',
    companyToken: token,
    title,
    // The list endpoint omits postingUrl; this canonical form resolves to the posting
    // and is replaced by the authoritative postingUrl when a detail fetch succeeds.
    url: `https://jobs.smartrecruiters.com/${encodeURIComponent(token)}/${encodeURIComponent(id)}`,
    locationRaw,
    remotePolicy: classifyRemote(locationRaw, '', {
      isRemote: readBoolean(location, 'remote'),
      isHybrid: readBoolean(location, 'hybrid'),
    }),
    descriptionText: '',
    fetchedAt,
  };

  const department = readString(readRecord(posting, 'department') ?? {}, 'label')
    ?? readString(readRecord(posting, 'function') ?? {}, 'label');
  if (department !== undefined) normalized.department = department;

  const employmentType = readString(readRecord(posting, 'typeOfEmployment') ?? {}, 'label');
  if (employmentType !== undefined) normalized.employmentType = employmentType;

  const postedAt = toIsoTimestamp(posting['releasedDate']);
  if (postedAt !== undefined) normalized.postedAt = postedAt;

  return normalized;
}

/** Page through the list endpoint until the board is exhausted or the cap is hit. */
async function fetchListing(token: string, maxPostings: number): Promise<NormalizedJob[]> {
  const fetchedAt = new Date().toISOString();
  const jobs: NormalizedJob[] = [];
  let offset = 0;

  while (jobs.length < maxPostings) {
    const limit = Math.min(PAGE_SIZE, maxPostings - jobs.length);

    let payload: unknown;
    try {
      payload = await fetchJson(listUrl(token, offset, limit));
    } catch (error) {
      if (error instanceof AtsNotFoundError) break;
      throw error;
    }

    const root = asRecord(payload);
    if (root === null) break;

    const content = readArray(root, 'content');
    if (content.length === 0) break;

    for (const entry of content) {
      const job = normalizeListEntry(entry, token, fetchedAt);
      if (job !== null) jobs.push(job);
    }

    offset += content.length;

    const totalFound = root['totalFound'];
    if (typeof totalFound === 'number' && offset >= totalFound) break;
    // A short page means the board ran out, regardless of what totalFound claimed.
    if (content.length < limit) break;
  }

  return jobs;
}

/**
 * Replace a posting's placeholder description and URL with detail-endpoint data.
 * Returns the job unchanged when the detail call fails — a missing description must
 * not discard an otherwise-valid posting.
 */
async function enrichWithDetail(job: NormalizedJob, token: string): Promise<NormalizedJob> {
  let payload: unknown;
  try {
    payload = await fetchJson(detailUrl(token, job.id));
  } catch {
    return job;
  }

  const detail = asRecord(payload);
  if (detail === null) return job;

  const descriptionHtml = buildDetailHtml(detail);
  const descriptionText = htmlToText(descriptionHtml ?? '');
  const postingUrl = readString(detail, 'postingUrl');
  const location = readRecord(detail, 'location') ?? {};

  const enriched: NormalizedJob = {
    ...job,
    url: postingUrl ?? job.url,
    descriptionText,
    remotePolicy: classifyRemote(job.locationRaw, descriptionText, {
      isRemote: readBoolean(location, 'remote'),
      isHybrid: readBoolean(location, 'hybrid'),
    }),
  };

  if (descriptionHtml !== undefined) enriched.descriptionHtml = descriptionHtml;
  return enriched;
}

/** Build an adapter with custom limits. */
export function createSmartRecruitersAdapter(options: SmartRecruitersOptions = {}): AtsAdapter {
  const detailLimit = options.detailLimit ?? DEFAULT_OPTIONS.detailLimit;
  const maxPostings = options.maxPostings ?? DEFAULT_OPTIONS.maxPostings;

  async function fetchJobs(token: string): Promise<NormalizedJob[]> {
    const jobs = await fetchListing(token, maxPostings);

    // Serial on purpose: the shared HTTP layer already serializes per host, and
    // issuing these sequentially keeps the intent explicit at the call site.
    const enriched: NormalizedJob[] = [];
    for (const [index, job] of jobs.entries()) {
      enriched.push(index < detailLimit ? await enrichWithDetail(job, token) : job);
    }
    return enriched;
  }

  async function probe(token: string): Promise<boolean> {
    try {
      const payload = await fetchJson(listUrl(token, 0, 1));
      const root = asRecord(payload);
      return root !== null && readArray(root, 'content').length > 0;
    } catch {
      return false;
    }
  }

  return { atsType: 'smartrecruiters', fetchJobs, probe };
}

export const smartRecruitersAdapter: AtsAdapter = createSmartRecruitersAdapter();
