#!/usr/bin/env bun
/**
 * Probe candidate board tokens and rank them by openings that fit a push.
 *
 * For an entry-level push: a posting counts when it is a
 * technical role (classifyRole = engineering) AND either
 *   - entry-level (junior / associate / intern / "I" / estágio …) in the US or
 *     Brazil, or
 *   - any technical role placed in Brazil.
 * Eligibility decides "in the US or Brazil" (relocation-us, brazil-local,
 * remote-brazil-eligible), so the count matches what prepare will accept.
 *
 *   bun run scripts/probe-boards.ts Companies/us-brazil-candidates.txt > logs/probe.txt
 *
 * Prints `ats:token  fits/total` for every board that answered, best first, and
 * a ready-to-use --targets list at the end.
 */

import { adapters } from "../src/ats/index.ts";
import { classifyRole } from "../src/pipeline/score.ts";
import { classifyEligibility } from "../src/pipeline/eligibility.ts";
import { ENTRY_LEVEL } from "../src/pipeline/level.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: bun run scripts/probe-boards.ts <tokens file>");
  process.exit(1);
}
const tokens = (await Bun.file(file).text())
  .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

type Row = { target: string; total: number; fits: number; examples: string[] };
const rows: Row[] = [];
const ATS = ["greenhouse", "lever", "ashby"] as const;

async function probe(token: string) {
  for (const ats of ATS) {
    try {
      const jobs = await adapters[ats]!.fetchJobs(token);
      if (jobs.length === 0) continue;
      const fits = jobs.filter((j) => {
        if (classifyRole(j.title).family !== "engineering") return false;
        const e = classifyEligibility(j);
        const usOrBrazil = ["relocation-us", "brazil-local", "remote-brazil-eligible"].includes(e.path);
        if (!usOrBrazil) return false;
        const brazil = e.path !== "relocation-us";
        return ENTRY_LEVEL.test(j.title) || brazil;
      });
      rows.push({ target: `${ats}:${token}`, total: jobs.length, fits: fits.length, examples: fits.slice(0, 3).map((j) => `${j.title} (${j.locationRaw.slice(0, 30)})`) });
      return;
    } catch {
      // not on this ATS — try the next
    }
  }
}

// Low concurrency: these are public job-board APIs, not ours to hammer.
const queue = [...tokens];
await Promise.all(Array.from({ length: 5 }, async () => {
  while (queue.length) await probe(queue.shift()!);
}));

rows.sort((a, b) => b.fits - a.fits || b.total - a.total);
for (const r of rows) {
  console.log(`${r.target.padEnd(36)} ${String(r.fits).padStart(4)}/${String(r.total).padEnd(5)} ${r.examples.join(" · ").slice(0, 150)}`);
}
const useful = rows.filter((r) => r.fits > 0).map((r) => r.target);
console.log(`\n${rows.length} boards answered · ${useful.length} with fitting openings`);
console.log(`--targets ${useful.join(",")}`);
