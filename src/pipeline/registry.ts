/**
 * Registry reader.
 *
 * `Companies/registry.yaml` is the persistent answer to "where do I look?" —
 * built by scripts/companies.ts, enriched by scripts/resolve.ts. This module is
 * what lets the pipeline actually USE it, instead of taking a hand-typed target
 * list on every run.
 *
 * That distinction matters: the registry is the asset that makes finding a
 * company work done once. A run that ignores it re-solves a problem that was
 * already solved.
 */

import { join } from "node:path";
import { PROJECT_ROOT } from "../corpus/load.ts";
import type { Target } from "./prepare.ts";

export const REGISTRY_PATH = join(PROJECT_ROOT, "Companies", "registry.yaml");

export interface RegistryEntry {
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
  resolveAttemptedAt?: string | null;
  notes?: string;
}

export interface RegistryFilter {
  /** Substring matched against name, domain and URL. */
  match?: string;
  /** Only these ATS platforms. */
  ats?: string[];
  /** Skip boards scanned within this many hours (freshness guard). */
  staleAfterHours?: number;
  /** Cap how many boards a single run targets. */
  limit?: number;
  /** Order boards by open-role count, largest first. */
  byJobCount?: boolean;
  /**
   * Round-robin through the registry: least-recently-scanned boards first,
   * never-scanned ahead of everything. Without this, ordering by job count
   * means every run hammers the same few large boards and the other thousand
   * companies are never reached.
   */
  rotate?: boolean;
}

export async function loadRegistry(path = REGISTRY_PATH): Promise<RegistryEntry[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(
      `no registry at ${path} — run \`bun run scripts/companies.ts\` first`,
    );
  }
  const doc = Bun.YAML.parse(await file.text()) as { companies?: RegistryEntry[] };
  return doc?.companies ?? [];
}

/**
 * The resolved boards a run should target, as `Target`s the pipeline accepts.
 */
export async function registryTargets(
  filter: RegistryFilter = {},
  path = REGISTRY_PATH,
): Promise<{ targets: Target[]; skipped: { reason: string; count: number }[] }> {
  const all = await loadRegistry(path);
  const skipped: { reason: string; count: number }[] = [];

  const count = (reason: string, n: number) => {
    if (n > 0) skipped.push({ reason, count: n });
  };

  const unresolved = all.filter((e) => !e.atsSupported).length;
  count("no job board resolved yet", unresolved);

  let usable = all.filter((e) => e.atsSupported && e.ats && e.atsToken);

  if (filter.match) {
    const m = filter.match.toLowerCase();
    const before = usable.length;
    usable = usable.filter((e) =>
      `${e.name} ${e.domain} ${e.url}`.toLowerCase().includes(m),
    );
    count(`did not match "${filter.match}"`, before - usable.length);
  }

  if (filter.ats?.length) {
    const before = usable.length;
    const allow = new Set(filter.ats);
    usable = usable.filter((e) => allow.has(e.ats!));
    count(`ATS not in ${filter.ats.join(",")}`, before - usable.length);
  }

  if (filter.staleAfterHours !== undefined) {
    const cutoff = Date.now() - filter.staleAfterHours * 3600_000;
    const before = usable.length;
    usable = usable.filter(
      (e) => !e.lastScanned || Date.parse(e.lastScanned) < cutoff,
    );
    count(`scanned within ${filter.staleAfterHours}h`, before - usable.length);
  }

  if (filter.rotate) {
    // Never-scanned first, then oldest scan. This is what makes successive runs
    // walk through the whole registry instead of re-reading the same boards.
    usable.sort((a, b) => {
      const ta = a.lastScanned ? Date.parse(a.lastScanned) : 0;
      const tb = b.lastScanned ? Date.parse(b.lastScanned) : 0;
      return ta - tb || a.name.localeCompare(b.name);
    });
  } else if (filter.byJobCount !== false) {
    // Biggest boards first: they carry the most chances per request.
    usable.sort((a, b) => (b.jobsTotal ?? 0) - (a.jobsTotal ?? 0));
  }

  if (filter.limit !== undefined && usable.length > filter.limit) {
    count("over --registry-limit", usable.length - filter.limit);
    usable = usable.slice(0, filter.limit);
  }

  // One board can back several registry rows; never fetch it twice in a run.
  const seen = new Set<string>();
  const targets: Target[] = [];
  for (const e of usable) {
    const key = `${e.ats}:${e.atsToken}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ atsType: e.ats!, token: e.atsToken!, company: e.name });
  }

  return { targets, skipped };
}

/** Write scan results back so the registry learns from every run. */
export async function recordScan(
  results: { atsType: string; token: string; jobsTotal: number; jobsEligible: number }[],
  path = REGISTRY_PATH,
): Promise<number> {
  const all = await loadRegistry(path);
  const byBoard = new Map(results.map((r) => [`${r.atsType}:${r.token}`, r]));
  const now = new Date().toISOString();
  let updated = 0;

  for (const e of all) {
    if (!e.atsSupported || !e.ats || !e.atsToken) continue;
    const r = byBoard.get(`${e.ats}:${e.atsToken}`);
    if (!r) continue;
    e.jobsTotal = r.jobsTotal;
    e.jobsEligible = r.jobsEligible;
    e.lastScanned = now;
    updated++;
  }

  const yaml = [
    "# Company registry — generated by scripts/companies.ts, enriched by",
    "# scripts/resolve.ts and by every pipeline run that scans a board.",
    `# Updated: ${now}`,
    `# ${all.length} companies | ${all.filter((e) => e.atsSupported).length} targetable`,
    "",
    "companies:",
    ...all.map((e) =>
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

  await Bun.write(path, yaml);
  return updated;
}
