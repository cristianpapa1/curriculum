#!/usr/bin/env bun
/**
 * ATS resolution.
 *
 * Most careers URLs in the registry are corporate pages — openai.com/careers,
 * anthropic.com/careers — that never name the ATS behind them. This probes the
 * supported job-board APIs with candidate tokens derived from the company name
 * and domain, and records whichever answers.
 *
 * Resumable and polite by construction: already-resolved companies are skipped,
 * probes run at low concurrency, and results are persisted after every batch so
 * an interrupted run loses nothing. Run it repeatedly with --limit rather than
 * hammering 950 companies in one pass.
 *
 *   bun run scripts/resolve.ts --limit 100
 *   bun run scripts/resolve.ts --limit 100 --offset 100
 *   bun run scripts/resolve.ts --all          # no limit; long and chatty
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { adapters } from "../src/ats/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(HERE, "..", "Companies", "registry.yaml");

interface Entry {
  name: string;
  slug: string;
  url: string;
  domain: string;
  ats: string | null;
  atsToken: string | null;
  atsSupported: boolean;
  jobsTotal: number | null;
  jobsEligible: number | null;
  lastScanned: string | null;
  notes?: string;
  /** Set when probing found nothing, so we don't retry forever. */
  resolveAttemptedAt?: string | null;
}

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

/**
 * Tokens that are ATS vendors, not employers.
 *
 * Without this, a company hosted at `job-boards.greenhouse.io/<x>` derives the
 * candidate token "greenhouse", which resolves to Greenhouse's OWN job board —
 * 18 real roles at the wrong company. Observed live: Wiz resolved to
 * `greenhouse:greenhouse`. An application sent there would go to Greenhouse.
 */
const VENDOR_TOKENS = new Set([
  "greenhouse", "boards", "job-boards", "jobboards", "lever", "ashby", "ashbyhq",
  "workable", "apply", "smartrecruiters", "workday", "myworkdayjobs", "icims",
  "taleo", "successfactors", "bamboohr", "recruitee", "teamtailor", "personio",
  "jobvite", "breezy", "rippling", "pinpointhq", "linkedin", "indeed",
  "glassdoor", "wellfound", "ycombinator", "careers", "jobs", "talent", "hire",
  "recruiting", "people", "work", "www",
]);

/** Candidate board tokens for a company, most likely first. */
function candidateTokens(e: Entry): string[] {
  const fromDomain = e.domain
    .replace(/^(careers|jobs|job|apply|work|boards|job-boards|recruiting|talent|hire|people|www)\./, "")
    .split(".")[0] ?? "";
  const fromName = e.name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const fromSlug = e.slug.replace(/-/g, "");

  const out = new Set<string>();
  // A token already recorded for this company is the best guess we have: it
  // came from the URL itself, so try it before anything derived.
  if (e.atsToken) out.add(e.atsToken.toLowerCase());

  for (const c of [fromDomain, fromName, fromSlug, e.slug]) {
    const t = c.trim().toLowerCase();
    if (t.length >= 2 && t.length <= 40) out.add(t);
  }

  // Never probe a vendor's own board as if it were the employer.
  for (const v of VENDOR_TOKENS) out.delete(v);

  return [...out];
}

/** Probe order: cheapest and most common first. */
const PROBE_ORDER = ["greenhouse", "ashby", "lever", "workable", "smartrecruiters"];

async function resolveOne(e: Entry): Promise<Entry> {
  const tokens = candidateTokens(e);

  for (const token of tokens) {
    for (const atsType of PROBE_ORDER) {
      const adapter = adapters[atsType];
      if (!adapter) continue;
      try {
        const jobs = await adapter.fetchJobs(token);
        if (jobs.length > 0) {
          return {
            ...e,
            ats: atsType,
            atsToken: token,
            atsSupported: true,
            jobsTotal: jobs.length,
            lastScanned: new Date().toISOString(),
            resolveAttemptedAt: new Date().toISOString(),
          };
        }
      } catch {
        // A failed probe is information, not an error. Keep going.
      }
    }
  }

  return { ...e, resolveAttemptedAt: new Date().toISOString() };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Merge entries that resolved to the same board.
 *
 * Two different careers URLs for one company (adyen.com/careers and
 * jobs.adyen.com, say) both resolve to `greenhouse:adyen`. Left alone they sit
 * in the registry as separate targets and get fetched twice per run.
 */
function consolidate(entries: Entry[]): { merged: Entry[]; removed: number } {
  const byBoard = new Map<string, Entry>();
  const out: Entry[] = [];
  let removed = 0;

  for (const e of entries) {
    if (!e.atsSupported || !e.ats || !e.atsToken) {
      out.push(e);
      continue;
    }
    const key = `${e.ats}:${e.atsToken}`;
    const prior = byBoard.get(key);
    if (!prior) {
      byBoard.set(key, e);
      out.push(e);
      continue;
    }
    // Keep the shorter, more canonical URL and preserve any human note.
    if (e.url.length < prior.url.length) prior.url = e.url;
    if (e.notes && !prior.notes) prior.notes = e.notes;
    removed++;
  }

  return { merged: out, removed };
}

function serialize(entries: Entry[]): string {
  const supported = entries.filter((e) => e.atsSupported).length;
  const attempted = entries.filter((e) => e.resolveAttemptedAt).length;
  return [
    "# Company registry — generated by scripts/companies.ts, enriched by scripts/resolve.ts.",
    "# Scan results and notes survive a rebuild.",
    `# Updated: ${new Date().toISOString()}`,
    `# ${entries.length} companies | ${supported} targetable | ${attempted} resolution-probed`,
    "",
    "companies:",
    ...entries.map((e) =>
      [
        `  - name: ${JSON.stringify(e.name)}`,
        `    slug: ${e.slug}`,
        `    url: ${JSON.stringify(e.url)}`,
        `    domain: ${e.domain}`,
        `    ats: ${e.ats ?? "null"}`,
        `    atsToken: ${e.atsToken ? JSON.stringify(e.atsToken) : "null"}`,
        `    atsSupported: ${e.atsSupported}`,
        `    jobsTotal: ${e.jobsTotal ?? "null"}`,
        `    jobsEligible: ${e.jobsEligible ?? "null"}`,
        `    lastScanned: ${e.lastScanned ? JSON.stringify(e.lastScanned) : "null"}`,
        ...(e.resolveAttemptedAt ? [`    resolveAttemptedAt: ${JSON.stringify(e.resolveAttemptedAt)}`] : []),
        ...(e.notes ? [`    notes: ${JSON.stringify(e.notes)}`] : []),
      ].join("\n"),
    ),
    "",
  ].join("\n");
}

/**
 * Verify boards that were assumed valid from the URL shape but never actually
 * called. A URL like `jobs.ashbyhq.com/anthropic` looks resolved, but the board
 * can be empty or moved — and an unverified board wastes a fetch on every run
 * and inflates the "targetable" count with roles that do not exist.
 */
async function verifyUnchecked(all: Entry[]): Promise<{ ok: number; demoted: number }> {
  const unchecked = all.filter(
    (e) => e.atsSupported && e.ats && e.atsToken && e.jobsTotal === null,
  );
  if (unchecked.length === 0) return { ok: 0, demoted: 0 };

  console.log(`verifying ${unchecked.length} URL-detected boards that were never called\n`);
  let ok = 0;
  let demoted = 0;

  await mapLimit(unchecked, 5, async (e) => {
    const adapter = adapters[e.ats!];
    if (!adapter) return;
    try {
      const jobs = await adapter.fetchJobs(e.atsToken!);
      e.jobsTotal = jobs.length;
      e.lastScanned = new Date().toISOString();
      if (jobs.length > 0) {
        ok++;
      } else {
        // Empty board: keep the token for reference but stop targeting it, and
        // clear resolveAttemptedAt so a later run can try other platforms.
        e.atsSupported = false;
        e.resolveAttemptedAt = null;
        e.notes = `${e.ats}:${e.atsToken} returned 0 jobs on ${new Date().toISOString().slice(0, 10)}`;
        demoted++;
        console.log(`  ✗ ${e.name.padEnd(24)} ${e.ats}:${e.atsToken} → 0 jobs, demoted`);
      }
    } catch {
      /* transient — leave it for the next run rather than demoting on a blip */
    }
  });

  return { ok, demoted };
}

async function main() {
  const doc = Bun.YAML.parse(await Bun.file(REGISTRY).text()) as { companies: Entry[] };
  const all = doc.companies;

  if (process.argv.includes("--verify")) {
    const { ok, demoted } = await verifyUnchecked(all);
    const { merged } = consolidate(all);
    await Bun.write(REGISTRY, serialize(merged));
    console.log(`\nverified: ${ok} live, ${demoted} demoted (empty board)`);
    console.log(`targetable now: ${merged.filter((e) => e.atsSupported).length}/${merged.length}`);
    return;
  }

  // --match narrows the batch to companies whose name, domain or URL contains
  // a substring, so a freshly-added region can be resolved before the backlog.
  const match = flag("match", "")?.toLowerCase() ?? "";
  const pending = all
    .filter((e) => !e.atsSupported && !e.resolveAttemptedAt)
    .filter((e) =>
      match === ""
        ? true
        : `${e.name} ${e.domain} ${e.url}`.toLowerCase().includes(match),
    );
  const offset = Number(flag("offset", "0"));
  const limit = process.argv.includes("--all")
    ? pending.length
    : Number(flag("limit", "50"));
  const batch = pending.slice(offset, offset + limit);

  if (batch.length === 0) {
    console.log(`nothing to resolve — ${all.filter((e) => e.atsSupported).length}/${all.length} targetable, ${pending.length} unprobed`);
    return;
  }

  console.log(`resolving ${batch.length} of ${pending.length} unprobed companies (concurrency 5)\n`);

  const byUrl = new Map(all.map((e) => [e.url, e]));
  let found = 0;

  const results = await mapLimit(batch, 5, async (e) => {
    const r = await resolveOne(e);
    if (r.atsSupported) {
      found++;
      console.log(`  ✓ ${r.name.padEnd(28)} ${r.ats}:${r.atsToken}  (${r.jobsTotal} jobs)`);
    }
    return r;
  });

  for (const r of results) byUrl.set(r.url, r);

  const { merged, removed } = consolidate([...byUrl.values()]);
  await Bun.write(REGISTRY, serialize(merged));

  const total = merged.filter((e) => e.atsSupported).length;
  console.log(`\nresolved ${found}/${batch.length} in this batch`);
  if (removed > 0) console.log(`merged ${removed} duplicate board(s)`);
  console.log(`targetable overall: ${total}/${merged.length}`);
  console.log(`remaining unprobed: ${merged.filter((e) => !e.atsSupported && !e.resolveAttemptedAt).length}`);
}

if (import.meta.main) await main();
