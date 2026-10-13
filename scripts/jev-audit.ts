#!/usr/bin/env bun
/**
 * Measure the Jev second opinion against decisions already on file.
 *
 * Before Jev sets anything aside in a live run, compare it with what was
 * already decided: every application folder is a posting the gates kept, and
 * Applications/_filtered/ holds the ones a gate moved out, each with a
 * FILTERED.md saying why. The interesting rows are the disagreements — what
 * Jev would add, and what the regex gates catch that Jev does not.
 * Report only: nothing is moved, marked or rewritten.
 *
 *   bun run scripts/jev-audit.ts               # 30 kept + 30 filtered, newest first
 *   bun run scripts/jev-audit.ts --limit 100   # per side
 *   bun run scripts/jev-audit.ts --all
 *
 * Answers are cached in logs/jev-answers.jsonl, so a second run is free, and
 * thresholds retuned in jev.ts can be re-measured without a single call.
 */

import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { loadCorpus } from "../src/corpus/load.ts";
import { APPLICATIONS_DIR, type ApplicationMeta } from "../src/ledger/ledger.ts";
import { checkFit } from "../src/pipeline/fit.ts";
import { classifyEligibility } from "../src/pipeline/eligibility.ts";
import { formatJevUsage, jevClientFromEnv, reviewWithJev, type JevVerdict } from "../src/pipeline/jev.ts";
import type { NormalizedJob } from "../src/ats/types.ts";

const argv = process.argv;
const all = argv.includes("--all");
const limitAt = argv.indexOf("--limit");
const limit = all ? Infinity : Number(limitAt === -1 ? 30 : argv[limitAt + 1]);

const client = await jevClientFromEnv();
if (!client) {
  console.error("TYPESAFE_API_KEY is not set — add it to .env (see .env.example)");
  process.exit(1);
}
const corpus = await loadCorpus();

interface Row {
  folder: string;
  meta: ApplicationMeta;
  job: NormalizedJob;
  /** Why it was filtered, from FILTERED.md; null for a kept application. */
  filteredFor: string | null;
}

async function load(dir: string, filtered: boolean): Promise<Row[]> {
  const rows: Row[] = [];
  const folders = (await readdir(dir).catch(() => [] as string[])).filter((f) => !f.startsWith("_")).sort().reverse();
  for (const folder of folders) {
    const base = join(dir, folder);
    const metaFile = Bun.file(join(base, "meta.json"));
    if (!(await metaFile.exists())) continue;
    const meta = (await metaFile.json()) as ApplicationMeta;
    const jd = await Bun.file(join(base, "job-description.md")).text().catch(() => "");
    // The snapshot is a header block, a rule, then the description (audit-batch.ts reads it the same way).
    const description = jd.split(/\n---\n/).slice(1).join("\n---\n") || jd;
    const filteredFor = filtered
      ? ((await Bun.file(join(base, "FILTERED.md")).text().catch(() => "")).match(/\*\*Reason:\*\*\s*(.+)/)?.[1] ?? "(no reason on file)")
      : null;
    rows.push({
      folder,
      meta,
      filteredFor,
      job: {
        id: meta.jobId, atsType: meta.atsType as NormalizedJob["atsType"], companyToken: meta.company,
        title: meta.roleTitle, url: meta.url, locationRaw: meta.locationRaw,
        remotePolicy: meta.remotePolicy as NormalizedJob["remotePolicy"],
        descriptionText: description, fetchedAt: meta.preparedAt,
      },
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

const rows = [
  ...(await load(APPLICATIONS_DIR, false)),
  ...(await load(join(APPLICATIONS_DIR, "_filtered"), true)),
];
console.log(`asking Jev (${client.model}) about ${rows.length} postings…\n`);

const results: { row: Row; regex: string | null; jev: JevVerdict }[] = [];
let failures = 0;
// A few at a time: well under the rate limit, and far quicker than one by one.
for (let i = 0; i < rows.length; i += 4) {
  await Promise.all(rows.slice(i, i + 4).map(async (row) => {
    const fit = checkFit(corpus, row.job);
    const regex = row.filteredFor ?? (fit.ok ? null : `fit/${fit.check}: ${fit.reason}`);
    try {
      const jev = await reviewWithJev(client, corpus, row.job, classifyEligibility(row.job).path);
      results.push({ row, regex, jev });
    } catch (err) {
      failures++;
      if (failures === 1) console.error(`  ! ${(err as Error).message}`);
    }
  }));
  if (failures > 0 && results.length === 0) break; // a bad key or an outage: no point continuing
}

const bothKeep = results.filter((r) => !r.regex && r.jev.ok);
const bothSetAside = results.filter((r) => r.regex && !r.jev.ok);
const jevOnly = results.filter((r) => !r.regex && !r.jev.ok);
/**
 * Gate reasons Jev is asked about. Sponsorship, posting language and a
 * language named in the title are not among its questions, so a posting set
 * aside for those is not a miss when Jev keeps it.
 */
const COMPARABLE = /^fit\/(level|reserved-audience|citizenship)|^fit\/title-tech: title is /;
const regexOnly = results.filter((r) => r.regex && r.jev.ok && COMPARABLE.test(r.regex));
const notAsked = results.filter((r) => r.regex && r.jev.ok && !COMPARABLE.test(r.regex));
const doubted = bothKeep.filter((r) => r.jev.doubts.length > 0);

console.log(`both keep        ${bothKeep.length}  (${doubted.length} with a Jev doubt noted)`);
console.log(`both set aside   ${bothSetAside.length}`);
console.log(`Jev only         ${jevOnly.length}   ← what Jev would add to the gates`);
console.log(`regex only       ${regexOnly.length}   ← caught by the gates, not by Jev`);
console.log(`not Jev's call   ${notAsked.length}   (sponsorship, language — outside its questions)`);
if (failures) console.log(`failed           ${failures}`);

const outcome = (m: ApplicationMeta) => (m.responseType ? `${m.status}, ${m.responseType}` : m.status);

if (jevOnly.length) {
  console.log("\n── Jev would set these aside (kept today) ──");
  for (const r of jevOnly) {
    console.log(`  ✗ ${r.row.meta.company} — ${r.row.meta.roleTitle}  [${outcome(r.row.meta)}]`);
    console.log(`      jev/${r.jev.check}: ${r.jev.reason}`);
  }
}
if (regexOnly.length) {
  console.log("\n── The gates set these aside; Jev would keep them ──");
  for (const r of regexOnly) {
    console.log(`  ✓ ${r.row.meta.company} — ${r.row.meta.roleTitle}`);
    console.log(`      gate: ${r.regex}`);
    if (r.jev.doubts.length) console.log(`      jev doubts: ${r.jev.doubts.join("; ")}`);
  }
}
if (doubted.length) {
  console.log("\n── Kept by both, with a Jev doubt ──");
  for (const r of doubted.slice(0, 25)) {
    console.log(`  ? ${r.row.meta.company} — ${r.row.meta.roleTitle}: ${r.jev.doubts.join("; ")}`);
  }
  if (doubted.length > 25) console.log(`  … and ${doubted.length - 25} more`);
}

console.log(`\n${formatJevUsage(client.usage)}`);
