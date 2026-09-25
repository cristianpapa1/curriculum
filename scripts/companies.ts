#!/usr/bin/env bun
/**
 * Company registry builder.
 *
 * Reads Companies/companies.md (a raw dump of careers-page URLs), deduplicates,
 * derives a company name, detects the ATS from the URL shape where possible,
 * and writes a structured registry the pipeline can actually target.
 *
 * Idempotent and re-runnable: the candidate keeps adding companies, so this must
 * merge into the existing registry rather than overwrite it. Anything already
 * carrying a scan result or a manual note keeps it.
 *
 *   bun run scripts/companies.ts            # rebuild registry from companies.md
 *   bun run scripts/companies.ts --write-md # also rewrite companies.md deduped
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "..");
const COMPANIES_DIR = join(PROJECT_ROOT, "Companies");
// (sources are every *.md in COMPANIES_DIR — see main())
const REGISTRY = join(COMPANIES_DIR, "registry.yaml");

/** ATS platforms detectable straight from the careers URL. */
const ATS_PATTERNS: { ats: string; supported: boolean; re: RegExp }[] = [
  { ats: "greenhouse", supported: true, re: /(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/([a-z0-9_-]+)/i },
  { ats: "greenhouse", supported: true, re: /greenhouse\.io\/embed\/job_board\?for=([a-z0-9_-]+)/i },
  { ats: "lever", supported: true, re: /jobs\.(?:eu\.)?lever\.co\/([a-z0-9_-]+)/i },
  { ats: "ashby", supported: true, re: /jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i },
  { ats: "workable", supported: true, re: /apply\.workable\.com\/([a-z0-9_-]+)/i },
  { ats: "smartrecruiters", supported: true, re: /(?:careers|jobs)\.smartrecruiters\.com\/([a-z0-9_-]+)/i },

  // Recognised but no adapter — recorded so we know the gap, not silently dropped.
  { ats: "workday", supported: false, re: /([a-z0-9_-]+)\.wd\d+\.myworkdayjobs\.com/i },
  { ats: "icims", supported: false, re: /([a-z0-9_-]+)\.icims\.com/i },
  { ats: "taleo", supported: false, re: /([a-z0-9_-]+)\.taleo\.net/i },
  { ats: "successfactors", supported: false, re: /([a-z0-9_-]+)\.successfactors\.com/i },
  { ats: "bamboohr", supported: false, re: /([a-z0-9_-]+)\.bamboohr\.com/i },
  { ats: "recruitee", supported: false, re: /([a-z0-9_-]+)\.recruitee\.com/i },
  { ats: "teamtailor", supported: false, re: /([a-z0-9_-]+)\.teamtailor\.com/i },
  { ats: "personio", supported: false, re: /([a-z0-9_-]+)\.jobs\.personio\.(?:de|com)/i },
  { ats: "jobvite", supported: false, re: /jobs\.jobvite\.com\/([a-z0-9_-]+)/i },
  { ats: "breezy", supported: false, re: /([a-z0-9_-]+)\.breezy\.hr/i },
  { ats: "rippling", supported: false, re: /ats\.rippling\.com\/([a-z0-9_-]+)/i },
  { ats: "pinpoint", supported: false, re: /([a-z0-9_-]+)\.pinpointhq\.com/i },
];

/** Host fragments that are the ATS, not the company. */
const ATS_HOSTS = [
  "greenhouse.io", "lever.co", "ashbyhq.com", "workable.com", "smartrecruiters.com",
  "myworkdayjobs.com", "icims.com", "taleo.net", "successfactors.com", "bamboohr.com",
  "recruitee.com", "teamtailor.com", "personio.de", "personio.com", "jobvite.com",
  "breezy.hr", "rippling.com", "pinpointhq.com", "linkedin.com", "indeed.com",
  "glassdoor.com", "wellfound.com", "angel.co", "ycombinator.com", "workatastartup.com",
];

export interface CompanyEntry {
  name: string;
  slug: string;
  url: string;
  domain: string;
  ats: string | null;
  atsToken: string | null;
  atsSupported: boolean;
  /** Populated later by the scan step. */
  jobsTotal?: number | null;
  jobsEligible?: number | null;
  lastScanned?: string | null;
  notes?: string;
  /** Set by scripts/resolve.ts once a company has been probed. */
  resolveAttemptedAt?: string | null;
}

function extractUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s)\]<>"']+/g)].map((m) => m[0]);
}

/** Canonical form used for dedupe: scheme-less, www-less, no trailing slash. */
function canonical(url: string): string {
  let u = url.trim().replace(/[.,;]+$/, "");
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    let path = parsed.pathname.replace(/\/+$/, "");
    // Drop tracking/query noise; a careers page is identified by host+path.
    return `${host}${path}`.toLowerCase();
  } catch {
    return u.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  }
}

function detectAts(url: string): { ats: string; token: string; supported: boolean } | null {
  for (const p of ATS_PATTERNS) {
    const m = url.match(p.re);
    if (m?.[1]) return { ats: p.ats, token: m[1].toLowerCase(), supported: p.supported };
  }
  return null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0]?.replace(/^www\./, "") ?? url;
  }
}

/** Company display name: prefer the real corporate domain over the ATS host. */
function deriveName(url: string, ats: { token: string } | null): string {
  const host = hostOf(url);
  const isAtsHost = ATS_HOSTS.some((h) => host.endsWith(h));

  let base: string;
  if (isAtsHost && ats?.token) {
    base = ats.token;
  } else if (isAtsHost) {
    // e.g. careers page on a job board with no token we can read
    const seg = (() => {
      try {
        return new URL(url).pathname.split("/").filter(Boolean)[0] ?? host;
      } catch {
        return host;
      }
    })();
    base = seg;
  } else {
    // strip common subdomains and the TLD
    base = host
      .replace(/^(careers|jobs|job|apply|work|boards|recruiting|talent|hire|people)\./, "")
      .replace(/\.(com|io|ai|co|net|org|dev|app|tech|cloud|inc|xyz|so|sh)(\.[a-z]{2})?$/, "")
      .split(".")[0] ?? host;
  }

  return base
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => (w.length <= 3 && w === w.toLowerCase() ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function loadExistingRegistry(): Promise<Map<string, CompanyEntry>> {
  const file = Bun.file(REGISTRY);
  if (!(await file.exists())) return new Map();
  try {
    const doc = Bun.YAML.parse(await file.text()) as { companies?: CompanyEntry[] };
    return new Map((doc?.companies ?? []).map((c) => [canonical(c.url), c]));
  } catch {
    console.warn("[companies] existing registry unreadable — rebuilding from scratch");
    return new Map();
  }
}

async function main() {
  // Read EVERY markdown file in Companies/, not just companies.md. the candidate
  // keeps dropping new source lists in (direct sites, harvested boards, region
  // sweeps); each becomes its own file and all of them feed one registry.
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(COMPANIES_DIR))
    .filter((f) => f.endsWith(".md"))
    .sort();

  if (files.length === 0) {
    console.error(`no .md source files in ${COMPANIES_DIR}`);
    process.exit(1);
  }

  const urls: string[] = [];
  for (const f of files) {
    const found = extractUrls(await Bun.file(join(COMPANIES_DIR, f)).text());
    urls.push(...found);
    console.log(`  ${f.padEnd(28)} ${found.length} URLs`);
  }
  console.log("");
  const existing = await loadExistingRegistry();

  const byCanonical = new Map<string, CompanyEntry>();
  let duplicates = 0;

  for (const url of urls) {
    const key = canonical(url);
    if (!key) continue;
    if (byCanonical.has(key)) {
      duplicates++;
      continue;
    }
    const ats = detectAts(url);
    const name = deriveName(url, ats);
    const prior = existing.get(key);

    // A board found by scripts/resolve.ts beats URL-pattern detection: the
    // resolver actually called the API and got jobs back. Overwriting it with a
    // fresh (usually null) pattern match silently discards real work.
    const resolved = prior?.atsSupported ? prior : null;

    byCanonical.set(key, {
      name: prior?.name ?? name,
      slug: slugify(prior?.name ?? name),
      url: url.replace(/[.,;]+$/, ""),
      domain: hostOf(url),
      ats: resolved?.ats ?? ats?.ats ?? prior?.ats ?? null,
      atsToken: resolved?.atsToken ?? ats?.token ?? prior?.atsToken ?? null,
      atsSupported: resolved?.atsSupported ?? ats?.supported ?? false,
      // Preserve anything the scan step or a human already recorded.
      jobsTotal: prior?.jobsTotal ?? null,
      jobsEligible: prior?.jobsEligible ?? null,
      lastScanned: prior?.lastScanned ?? null,
      resolveAttemptedAt: prior?.resolveAttemptedAt ?? null,
      ...(prior?.notes ? { notes: prior.notes } : {}),
    });
  }

  const entries = [...byCanonical.values()].sort((a, b) => {
    // Directly targetable companies first, then recognised-but-unsupported, then unknown.
    const rank = (c: CompanyEntry) => (c.atsSupported ? 0 : c.ats ? 1 : 2);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });

  const supported = entries.filter((e) => e.atsSupported);
  const known = entries.filter((e) => e.ats && !e.atsSupported);
  const unknown = entries.filter((e) => !e.ats);

  // ── registry.yaml ───────────────────────────────────────────────────────
  const yaml = [
    "# Company registry — generated by scripts/companies.ts. Re-runnable.",
    "# Source: Companies/companies.md. Scan results and notes survive a rebuild.",
    `# Generated: ${new Date().toISOString()}`,
    "#",
    `# ${entries.length} unique companies from ${urls.length} URLs (${duplicates} duplicates removed)`,
    `#   ${supported.length} directly targetable (adapter exists)`,
    `#   ${known.length} known ATS, no adapter yet`,
    `#   ${unknown.length} ATS not yet identified`,
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

  await Bun.write(REGISTRY, yaml);

  // ── companies.md, deduped and organised ─────────────────────────────────
  if (process.argv.includes("--write-md")) {
    const section = (title: string, list: CompanyEntry[], note: string) =>
      list.length === 0
        ? []
        : [
            `## ${title} (${list.length})`,
            "",
            note,
            "",
            ...list.map((e) =>
              e.atsToken
                ? `- **${e.name}** — \`${e.ats}:${e.atsToken}\` — [careers](${e.url})`
                : `- **${e.name}** — ${e.ats ?? "ATS unknown"} — [careers](${e.url})`,
            ),
            "",
          ];

    const md = [
      "# Target companies",
      "",
      `> Generated by \`bun run scripts/companies.ts --write-md\`. ${entries.length} unique`,
      `> companies, deduplicated from ${urls.length} URLs (${duplicates} duplicates removed).`,
      "> Add new careers URLs anywhere in this file and re-run — dedupe is idempotent.",
      "",
      ...section(
        "Directly targetable",
        supported,
        "These expose a JSON job board the pipeline can already read. `bun run src/cli.ts scan <ats>:<token>`",
      ),
      ...section(
        "Known ATS, adapter missing",
        known,
        "Recognised platform, no adapter written yet. Each needs an ingest tier or a Firecrawl fallback.",
      ),
      ...section(
        "ATS not yet identified",
        unknown,
        "Careers pages whose platform could not be read from the URL. `detectAts()` or Firecrawl can resolve these.",
      ),
    ].join("\n");

    await Bun.write(join(COMPANIES_DIR, "companies.md"), md);
  }

  // ── report ──────────────────────────────────────────────────────────────
  console.log(`URLs found:            ${urls.length}`);
  console.log(`duplicates removed:    ${duplicates}`);
  console.log(`unique companies:      ${entries.length}`);
  console.log("");
  console.log(`directly targetable:   ${supported.length}`);
  console.log(`known ATS, no adapter: ${known.length}`);
  console.log(`ATS unidentified:      ${unknown.length}`);
  console.log("");
  const byAts = new Map<string, number>();
  for (const e of entries) byAts.set(e.ats ?? "(unknown)", (byAts.get(e.ats ?? "(unknown)") ?? 0) + 1);
  console.log("by platform:");
  for (const [ats, n] of [...byAts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ats.padEnd(18)} ${n}`);
  }
  console.log(`\nregistry → ${REGISTRY}`);
}

if (import.meta.main) await main();
