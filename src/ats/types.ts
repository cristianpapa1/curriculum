/**
 * Shared types for the ATS discovery/ingest layer.
 *
 * Scope boundary: this layer DISCOVERS and INGESTS job postings only.
 * It never submits applications and holds no candidate credentials.
 */

/** Remote-work classification derived from location text, description text and ATS-native flags. */
export type RemotePolicy = 'remote' | 'hybrid' | 'onsite' | 'unknown';

/** Identifier for each supported ATS backend. */
export type AtsType =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'workable'
  | 'smartrecruiters'
  | 'gupy';

/** A job posting normalized into a single shape across every ATS. */
export interface NormalizedJob {
  /** ATS-native posting id, stringified. Unique within (atsType, companyToken). */
  id: string;
  /** Which ATS this posting came from. */
  atsType: AtsType;
  /** The board token used to fetch it (e.g. "stripe"). */
  companyToken: string;
  /** Posting title, whitespace-trimmed. */
  title: string;
  /** Public, human-viewable posting URL. */
  url: string;
  /** Location exactly as the ATS reported it, before interpretation. */
  locationRaw: string;
  /** Interpreted remote policy. See {@link classifyRemote}. */
  remotePolicy: RemotePolicy;
  /** Description as plain text: entities decoded, tags stripped, blank lines collapsed. */
  descriptionText: string;
  /** Raw description HTML when the ATS supplies it. */
  descriptionHtml?: string;
  /** Department/team when available. */
  department?: string;
  /** Employment type (e.g. "FullTime", "Full-time") as the ATS words it. */
  employmentType?: string;
  /** Compensation string as published. Not parsed into a range — deliberately raw. */
  salaryRaw?: string;
  /** ISO-8601 publication/update timestamp when the ATS supplies one. */
  postedAt?: string;
  /** ISO-8601 timestamp of when this record was fetched. */
  fetchedAt: string;
}

/** Contract every ATS adapter implements. */
export interface AtsAdapter {
  /** Discriminator matching the registry key. */
  atsType: AtsType;
  /**
   * Fetch every open posting for `token`.
   * Returns `[]` when the token is not found (HTTP 404) rather than throwing.
   * Throws {@link AtsError} for transport failures, timeouts and malformed payloads.
   */
  fetchJobs(token: string): Promise<NormalizedJob[]>;
  /**
   * Report whether `token` is a live board on this ATS with at least one posting.
   * Returns `false` on 404 and on well-formed-but-empty boards. Never throws.
   */
  probe(token: string): Promise<boolean>;
}

/** A single target to ingest. */
export interface AtsTarget {
  token: string;
  atsType: AtsType;
}

/** Records one target that failed so a bad target never hides the rest. */
export interface AtsFailure {
  token: string;
  atsType: AtsType;
  /** Human-readable failure cause. */
  message: string;
  /** HTTP status when the failure came from a response, else undefined. */
  status?: number;
}

/** Result of a multi-target ingest run: successes and failures side by side. */
export interface FetchAllReport {
  jobs: NormalizedJob[];
  failures: AtsFailure[];
}

/** Options accepted by {@link fetchAll}. */
export interface FetchAllOptions {
  /** Max targets fetched in parallel. Defaults to 4. */
  concurrency?: number;
  /** Invoked per failed target, as it happens. */
  onFailure?: (failure: AtsFailure) => void;
}

/** Verdict from a Brazil work-eligibility check. */
export interface BrazilEligibility {
  eligible: boolean;
  /** The phrase that decided the verdict, so the call is auditable. */
  reason: string;
}

/** Error raised by the ATS HTTP layer. */
export class AtsError extends Error {
  readonly status?: number;
  readonly url: string;

  constructor(message: string, url: string, status?: number) {
    super(message);
    this.name = 'AtsError';
    this.url = url;
    this.status = status;
  }
}

/** Raised when a board token does not exist (HTTP 404). Never retried. */
export class AtsNotFoundError extends AtsError {
  constructor(url: string) {
    super('token not found', url, 404);
    this.name = 'AtsNotFoundError';
  }
}
