/**
 * Gupy adapter — search-based discovery.
 *
 * Most Brazilian employers (Stefanini, Itaú, Ambev, Stone, Magalu …) post on
 * Gupy, and that is where Brazil's junior security and IT roles are. Gupy has no
 * per-company board API like Greenhouse; its public job portal is backed by a
 * search endpoint:
 *
 *   https://employability-portal.gupy.io/api/v1/jobs?jobName=<term>&limit=&offset=
 *
 * So the "token" here is a SEARCH TERM ("analista de segurança da informação"),
 * not a company. Results are paginated, deduplicated by id, and normalized like
 * every other board. Discovery only: applying on Gupy needs a candidate account
 * and a multi-step flow, so Gupy postings are submitted by hand from their
 * MANUAL-SUBMIT.md pack.
 */

import { htmlToText } from './html.ts';
import { classifyRemote } from './remote.ts';
import { AtsError, type AtsAdapter, type NormalizedJob, type RemotePolicy } from './types.ts';

const PAGE = 100;
const MAX_RESULTS = 300;

interface GupyJob {
  id: number;
  name: string;
  description?: string;
  careerPageName?: string;
  jobUrl?: string;
  city?: string;
  state?: string;
  country?: string;
  isRemoteWork?: boolean;
  workplaceType?: string;
  publishedDate?: string;
  type?: string;
}

const slug = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function policyOf(job: GupyJob, location: string, text: string): RemotePolicy {
  if (job.workplaceType === "remote" || job.isRemoteWork) return "remote";
  if (job.workplaceType === "hybrid") return "hybrid";
  if (job.workplaceType === "on-site") return "onsite";
  return classifyRemote(location, text);
}

async function fetchJobs(term: string): Promise<NormalizedJob[]> {
  const out: NormalizedJob[] = [];
  const seen = new Set<number>();
  const fetchedAt = new Date().toISOString();
  for (let offset = 0; offset < MAX_RESULTS; offset += PAGE) {
    const url = `https://employability-portal.gupy.io/api/v1/jobs?jobName=${encodeURIComponent(term)}&limit=${PAGE}&offset=${offset}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }).catch((e) => {
      throw new AtsError(`gupy search "${term}": ${(e as Error).message}`, url);
    });
    if (res.status === 404) return out;
    if (!res.ok) throw new AtsError(`gupy search "${term}": HTTP ${res.status}`, url, res.status);
    const body = (await res.json()) as { data?: GupyJob[]; pagination?: { total?: number } };
    const page = body.data ?? [];
    for (const job of page) {
      if (seen.has(job.id) || !job.jobUrl) continue;
      seen.add(job.id);
      const place = [job.city, job.state, job.country].filter(Boolean).join(", ");
      const text = htmlToText(job.description ?? "");
      const policy = policyOf(job, place, text);
      out.push({
        id: String(job.id),
        atsType: "gupy",
        companyToken: slug(job.careerPageName ?? "gupy"),
        title: job.name.trim(),
        url: job.jobUrl,
        // Remote postings carry the country so Brazil eligibility is decided on it.
        locationRaw: policy === "remote" ? `Remoto, ${job.country ?? "Brasil"}` : place || "Brasil",
        remotePolicy: policy,
        descriptionText: text,
        descriptionHtml: job.description,
        employmentType: job.type,
        postedAt: job.publishedDate,
        fetchedAt,
      });
    }
    if (page.length < PAGE || offset + PAGE >= (body.pagination?.total ?? 0)) break;
  }
  return out;
}

export const gupyAdapter: AtsAdapter = {
  atsType: "gupy",
  fetchJobs,
  probe: async (term: string) => (await fetchJobs(term)).length > 0,
};
