/**
 * Target scan — how many Brazil-eligible roles does a board actually have?
 *
 * Usage: bun run scripts/scan.ts greenhouse:gitlab ashby:supabase greenhouse:elastic
 *
 * Exists because target selection dominates outcome: one employer returns 600+
 * jobs and none eligible from the candidate's country, while a smaller one
 * returns genuine in-country roles. Scan before committing a company to a
 * target list.
 */
import { adapters } from "../src/ats/index.ts";
import { isBrazilEligible } from "../src/ats/remote.ts";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: bun run scripts/scan.ts <ats>:<token> [...]");
  process.exit(1);
}

for (const arg of args) {
  const [ats, token] = arg.split(":");
  const adapter = ats ? adapters[ats] : undefined;
  if (!adapter || !token) {
    console.log(`${arg}: unknown ats "${ats}" (have: ${Object.keys(adapters).join(", ")})`);
    continue;
  }
  try {
    const jobs = await adapter.fetchJobs(token);
    if (jobs.length === 0) {
      console.log(`${arg}: no jobs — token likely wrong`);
      continue;
    }
    const eligible = jobs.filter((j) => isBrazilEligible(j).eligible);
    const pct = ((eligible.length / jobs.length) * 100).toFixed(1);
    console.log(`${arg}: ${jobs.length} jobs, ${eligible.length} Brazil-eligible (${pct}%)`);
    for (const j of eligible.slice(0, 5)) {
      console.log(`    → ${j.title} @ ${j.locationRaw} [${isBrazilEligible(j).reason}]`);
    }
  } catch (err) {
    console.log(`${arg}: ERROR ${(err as Error).message}`);
  }
}
