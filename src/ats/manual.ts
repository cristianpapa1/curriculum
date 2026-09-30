/**
 * Postings described by hand.
 *
 * Not every posting lives on a board this pipeline can read. A talent
 * marketplace behind a login, a role sent by email, a company with its own
 * custom careers app — the posting is real, and the work of tailoring a CV,
 * checking eligibility and recording the application is the same. So a posting
 * can be written into a YAML or JSON file and ingested like any other:
 *
 *   bun run src/cli.ts prepare --targets manual:Postings/acme-backend.yaml
 *
 * The file holds one posting or a list of them, with the fields a board would
 * have supplied:
 *
 *   - company: Acme                  # required
 *     title: Back-end Engineer       # required
 *     url: https://…/apply           # required — where the application is made
 *     location: Remote, LATAM        # as the posting words it
 *     remote: remote                 # remote | hybrid | onsite (default: inferred)
 *     description: |                 # the posting text, requirements included
 *       …
 *
 * `remote` is optional: with it absent the location and description are read
 * the same way a board's are (`classifyRemote`). `id` is optional too and
 * defaults to a hash of the URL, so re-running the same file updates one
 * application rather than creating duplicates.
 *
 * These postings are never submitted automatically — the pipeline has no form
 * to fill, only a link — so they become manual packs (MANUAL_BOARDS).
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { PROJECT_ROOT } from "../corpus/load.ts";
import { classifyRemote } from "./remote.ts";
import { htmlToText } from "./html.ts";
import { AtsError, type AtsAdapter, type NormalizedJob, type RemotePolicy } from "./types.ts";

interface ManualPosting {
  company?: string;
  companyToken?: string;
  title?: string;
  url?: string;
  location?: string;
  locationRaw?: string;
  remote?: string;
  remotePolicy?: string;
  description?: string;
  descriptionText?: string;
  descriptionHtml?: string;
  department?: string;
  employmentType?: string;
  salary?: string;
  salaryRaw?: string;
  id?: string;
}

const POLICIES: RemotePolicy[] = ["remote", "hybrid", "onsite", "unknown"];

/** Stable short id from the apply URL, so re-ingesting a file is idempotent. */
function idFor(posting: ManualPosting): string {
  if (posting.id) return String(posting.id);
  return Bun.hash(posting.url ?? `${posting.company}:${posting.title}`).toString(16).slice(0, 12);
}

/** A company token in the shape the rest of the pipeline expects. */
function tokenFor(posting: ManualPosting): string {
  if (posting.companyToken) return posting.companyToken;
  return (posting.company ?? "manual").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function one(posting: ManualPosting, source: string): NormalizedJob {
  for (const field of ["company", "title", "url"] as const) {
    if (!posting[field]) {
      throw new AtsError(`a posting is missing "${field}" — company, title and url are required`, source);
    }
  }

  const locationRaw = (posting.location ?? posting.locationRaw ?? "").trim();
  const descriptionText = (
    posting.description ??
    posting.descriptionText ??
    (posting.descriptionHtml ? htmlToText(posting.descriptionHtml) : "")
  ).trim();

  const declared = (posting.remote ?? posting.remotePolicy ?? "").trim().toLowerCase();
  if (declared && !POLICIES.includes(declared as RemotePolicy)) {
    throw new AtsError(`remote must be one of ${POLICIES.join(", ")} — got "${declared}"`, source);
  }
  // With nothing declared, read the posting the way a board's is read.
  const remotePolicy = (declared as RemotePolicy) || classifyRemote(locationRaw, descriptionText);

  const job: NormalizedJob = {
    // The posting is described by hand, but everything downstream — eligibility,
    // scoring, rendering, the ledger — treats it as an ordinary posting.
    id: idFor(posting),
    atsType: "manual",
    companyToken: tokenFor(posting),
    title: String(posting.title).trim(),
    url: String(posting.url).trim(),
    locationRaw,
    remotePolicy,
    descriptionText,
    fetchedAt: new Date().toISOString(),
  };
  if (posting.descriptionHtml) job.descriptionHtml = posting.descriptionHtml;
  if (posting.department) job.department = posting.department;
  if (posting.employmentType) job.employmentType = posting.employmentType;
  const salary = posting.salary ?? posting.salaryRaw;
  if (salary) job.salaryRaw = salary;
  return job;
}

function readFile(token: string): ManualPosting[] {
  const path = isAbsolute(token) ? token : join(PROJECT_ROOT, token);
  if (!existsSync(path)) {
    throw new AtsError(`manual posting file not found`, path, 404);
  }
  const text = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = path.endsWith(".json") ? JSON.parse(text) : Bun.YAML.parse(text);
  } catch (err) {
    throw new AtsError((err as Error).message, path);
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list as ManualPosting[];
}

export const manualAdapter: AtsAdapter = {
  atsType: "manual",

  async fetchJobs(token: string): Promise<NormalizedJob[]> {
    const path = isAbsolute(token) ? token : join(PROJECT_ROOT, token);
    return readFile(token).map((p) => one(p, path));
  },

  async probe(token: string): Promise<boolean> {
    try {
      return (await this.fetchJobs(token)).length > 0;
    } catch {
      return false;
    }
  },
};
