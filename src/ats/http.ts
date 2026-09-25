/**
 * Shared HTTP layer for every ATS adapter.
 *
 * Guarantees: a 20s timeout on every request, one retry on 5xx/network failure with
 * 1s backoff, no retry on 404, and serialized access per host so we never hammer a
 * single job board with parallel requests.
 */

import { AtsError, AtsNotFoundError } from './types.ts';

const REQUEST_TIMEOUT_MS = 20_000;
const RETRY_BACKOFF_MS = 1_000;
/** One retry after the initial attempt. */
const MAX_RETRIES = 1;
/** Minimum gap between two requests to the same host. */
const PER_HOST_DELAY_MS = 120;

/** Identifies the bot to job boards; CONTACT_EMAIL lets them reach whoever runs it. */
const USER_AGENT =
  `CurriculumJobIngest/0.1 (+https://github.com/cristianpapa1/curriculum; job discovery bot${process.env.CONTACT_EMAIL ? `; contact: ${process.env.CONTACT_EMAIL}` : ""})`;

/**
 * Tail of the in-flight request chain for each host. Awaiting the stored promise
 * before issuing a request serializes same-host traffic without blocking other hosts.
 */
const hostQueues = new Map<string, Promise<void>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Queue `task` behind any in-flight request to the same host. */
async function runSerializedPerHost<T>(url: string, task: () => Promise<T>): Promise<T> {
  const host = new URL(url).host;
  const previous = hostQueues.get(host) ?? Promise.resolve();

  // The queue tracks completion only; a failed request must not poison the chain.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  hostQueues.set(host, previous.then(() => gate));

  await previous;
  try {
    return await task();
  } finally {
    await sleep(PER_HOST_DELAY_MS);
    release();
    // Drop the entry once this request is the last one queued, so the map cannot grow
    // without bound across a long-running process.
    if (hostQueues.get(host) === gate) hostQueues.delete(host);
  }
}

/** True for failures worth one retry: transport errors and 5xx responses. */
function isRetryable(error: unknown): boolean {
  if (error instanceof AtsNotFoundError) return false;
  if (error instanceof AtsError) {
    return error.status === undefined || error.status >= 500;
  }
  return true;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function requestOnce(url: string, accept: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'follow',
    });
  } catch (error) {
    // AbortSignal.timeout surfaces as TimeoutError; both it and transport errors retry.
    throw new AtsError(`request failed: ${describe(error)}`, url);
  }

  if (response.status === 404) throw new AtsNotFoundError(url);
  if (!response.ok) {
    throw new AtsError(`HTTP ${response.status} ${response.statusText}`, url, response.status);
  }
  return response;
}

/**
 * Fetch `url` and parse JSON.
 *
 * The parsed value is returned as `unknown` — callers must validate its shape before
 * trusting it. Throws {@link AtsNotFoundError} on 404, {@link AtsError} otherwise.
 */
export async function fetchJson(url: string): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await runSerializedPerHost(url, async () => {
        const response = await requestOnce(url, 'application/json');
        const body = await response.text();
        try {
          return JSON.parse(body) as unknown;
        } catch (error) {
          // A non-JSON body from a 2xx response is a contract break, not a transport
          // fault, so it is reported with a status and never retried.
          throw new AtsError(
            `response was not valid JSON: ${describe(error)}`,
            url,
            response.status,
          );
        }
      });
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === MAX_RETRIES) break;
      await sleep(RETRY_BACKOFF_MS);
    }
  }

  throw lastError instanceof AtsError
    ? lastError
    : new AtsError(`request failed: ${describe(lastError)}`, url);
}

/** Narrow an unknown value to a plain object. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read a string field, trimming it. Returns undefined for absent/blank/non-string values. */
export function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Read an id field that may arrive as string or number. */
export function readId(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Read a boolean field, ignoring non-boolean values. */
export function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** Read a nested object field. */
export function readRecord(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  return asRecord(source[key]);
}

/** Read an array field, returning `[]` when absent so callers need no null checks. */
export function readArray(source: Record<string, unknown>, key: string): unknown[] {
  const value = source[key];
  return Array.isArray(value) ? value : [];
}

/**
 * Convert an ATS timestamp to ISO-8601.
 * Accepts ISO strings and epoch-millisecond numbers (Lever uses the latter).
 */
export function toIsoTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const fromEpoch = new Date(value);
    return Number.isNaN(fromEpoch.getTime()) ? undefined : fromEpoch.toISOString();
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  return undefined;
}
