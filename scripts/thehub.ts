#!/usr/bin/env bun
/**
 * The Hub (thehub.io) company harvester — Nordics.
 *
 * thehub.io is a Nuxt app that ships its full page state in `window.__NUXT__`
 * as a minified IIFE. Evaluating that expression gives the job list with each
 * company's name AND website, which is exactly what the registry needs — no
 * headless browser, no scraping of rendered DOM.
 *
 * Politeness: pages are fetched sequentially with a delay. This is a small
 * public job board, not something to hammer.
 *
 *   bun run scripts/thehub.ts                  # default Nordic sweep
 *   bun run scripts/thehub.ts --max-pages 5    # shallower
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "Companies");
const OUT = join(DIR, "thehub-nordics.md");

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

/** Queries the candidate asked for, plus the Nordic country sweep. */
const QUERIES: string[] = [
  "https://thehub.io/jobs?countryCode=FI",
  "https://thehub.io/jobs?countryCode=SE",
  "https://thehub.io/jobs?countryCode=DK",
  "https://thehub.io/jobs?countryCode=NO",
  "https://thehub.io/jobs?countryCode=IS",
  "https://thehub.io/jobs?remote=true",
  "https://thehub.io/jobs/location/finland",
  "https://thehub.io/jobs/location/finland/helsinki",
  "https://thehub.io/jobs/location/finland/espoo",
  "https://thehub.io/jobs/location/finland/tampere",
  "https://thehub.io/jobs/location/finland/?role=devops",
  "https://thehub.io/jobs/location/finland/?role=engineer",
];

export interface HubCompany {
  name: string;
  website: string | null;
  /** Roles seen for this company during the sweep. */
  roles: Set<string>;
  countries: Set<string>;
}

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchNuxt(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/window\.__NUXT__=([\s\S]*?);?<\/script>/);
    if (!m?.[1]) return null;
    // The payload is a self-contained data IIFE — no browser globals touched.
    return new Function(`"use strict"; return (${m[1].trim().replace(/;$/, "")});`)();
  } catch {
    return null;
  }
}

function extractJobs(state: any): any[] {
  const j = state?.state?.jobs?.jobs;
  return j?.data ?? j?.docs ?? [];
}

function pageUrl(base: string, page: number): string {
  if (page <= 1) return base;
  return base.includes("?") ? `${base}&page=${page}` : `${base}?page=${page}`;
}

async function main() {
  const maxPages = Number(flag("max-pages", "14"));
  const companies = new Map<string, HubCompany>();
  let totalJobs = 0;

  for (const q of QUERIES) {
    const first = await fetchNuxt(q);
    if (!first) {
      console.log(`  ✗ ${q} — no state`);
      continue;
    }
    const meta = first?.state?.jobs?.jobs;
    const pages = Math.min(meta?.pages ?? 1, maxPages);
    console.log(`${q}\n    ${meta?.total ?? "?"} jobs across ${meta?.pages ?? "?"} pages (fetching ${pages})`);

    for (let page = 1; page <= pages; page++) {
      const state = page === 1 ? first : await fetchNuxt(pageUrl(q, page));
      if (!state) break;
      const jobs = extractJobs(state);
      if (jobs.length === 0) break;
      totalJobs += jobs.length;

      for (const job of jobs) {
        const c = job.company ?? {};
        const name = (c.name ?? job.companyName ?? "").trim();
        if (!name) continue;
        const key = name.toLowerCase();
        const entry = companies.get(key) ?? {
          name,
          website: null,
          roles: new Set<string>(),
          countries: new Set<string>(),
        };
        const site = (c.website ?? "").trim();
        if (site && !entry.website) entry.website = site.replace(/\/+$/, "");
        const title = (job.title ?? job.jobTitle ?? "").trim();
        if (title) entry.roles.add(title);
        const country = c.location?.country ?? job.location?.country ?? c.country ?? "";
        if (typeof country === "string" && country) entry.countries.add(country);
        companies.set(key, entry);
      }
      if (page < pages) await sleep(700); // be polite
    }
    await sleep(1000);
  }

  const list = [...companies.values()].sort((a, b) => a.name.localeCompare(b.name));
  const withSite = list.filter((c) => c.website);

  const md = [
    "# The Hub — Nordic companies",
    "",
    `> Harvested by \`bun run scripts/thehub.ts\` on ${new Date().toISOString().slice(0, 10)}.`,
    `> ${list.length} companies (${withSite.length} with a website) from ${totalJobs} job postings`,
    "> across Finland, Sweden, Denmark, Norway, Iceland and remote.",
    ">",
    "> Websites below are ingested by `scripts/companies.ts` into the registry, then",
    "> `scripts/resolve.ts` finds each one's job board.",
    "",
    "| company | website | roles seen |",
    "|---|---|---|",
    ...list.map(
      (c) =>
        `| ${c.name} | ${c.website ? `[${c.website.replace(/^https?:\/\//, "")}](${c.website})` : "-"} | ${
          [...c.roles].slice(0, 3).join("; ").replace(/\|/g, "/") || "-"
        } |`,
    ),
    "",
    "## Website URLs for ingest",
    "",
    ...withSite.map((c) => c.website!),
    "",
  ].join("\n");

  await Bun.write(OUT, md);
  console.log(`\n${list.length} companies (${withSite.length} with websites) from ${totalJobs} postings`);
  console.log(`→ ${OUT}`);
}

if (import.meta.main) await main();
