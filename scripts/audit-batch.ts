#!/usr/bin/env bun
/**
 * Audit prepared applications against the current fit gates.
 *
 * Gates tighten as live runs teach us things; applications prepared before a
 * gate existed are not re-checked automatically. This applies the current
 * checks to everything still `prepared` and MOVES failures — never deletes —
 * into Applications/_filtered/<folder>/ with a FILTERED.md explaining why, so
 * the candidate can disagree with any of them and move one back.
 *
 *   bun run scripts/audit-batch.ts            # report only
 *   bun run scripts/audit-batch.ts --apply    # move failures to _filtered/
 */

import { join } from "node:path";
import { readdir, rename, mkdir } from "node:fs/promises";
import { loadCorpus } from "../src/corpus/load.ts";
import { APPLICATIONS_DIR, rebuildLedgerView, type ApplicationMeta } from "../src/ledger/ledger.ts";
import { checkFit } from "../src/pipeline/fit.ts";
import { checkLanguages } from "../src/pipeline/languages.ts";
import { classifyEligibility } from "../src/pipeline/eligibility.ts";
import { updateStatus } from "../src/ledger/ledger.ts";

const apply = process.argv.includes("--apply");
const corpus = await loadCorpus();
const FILTERED = join(APPLICATIONS_DIR, "_filtered");

let kept = 0;
const rejected: { folder: string; meta: ApplicationMeta; reason: string }[] = [];

for (const folder of (await readdir(APPLICATIONS_DIR)).sort()) {
  if (folder.startsWith("_")) continue;
  const metaFile = Bun.file(join(APPLICATIONS_DIR, folder, "meta.json"));
  if (!(await metaFile.exists())) continue;
  const meta = (await metaFile.json()) as ApplicationMeta;
  if (meta.status !== "prepared") continue;

  const jd = await Bun.file(join(APPLICATIONS_DIR, folder, "job-description.md")).text().catch(() => "");
  const description = jd.split(/\n---\n/).slice(1).join("\n---\n") || jd;

  // Recompute eligibility with the CURRENT classifier; the flag stored at
  // preparation time may predate a fix (multi-office UK+EU postings).
  const elig = classifyEligibility({
    id: meta.jobId, atsType: meta.atsType as any, companyToken: meta.company, title: meta.roleTitle,
    url: meta.url, locationRaw: meta.locationRaw, remotePolicy: meta.remotePolicy as any,
    descriptionText: description, fetchedAt: meta.preparedAt,
  });
  if (apply && meta.eligibilityPath !== "remote-brazil-eligible" && elig.requiresSponsorship !== meta.requiresSponsorship) {
    await updateStatus(meta.id, { requiresSponsorship: elig.requiresSponsorship, eligibilityReason: elig.reason });
  }

  let reason: string | null = null;
  if (elig.requiresSponsorship && meta.eligibilityPath !== "relocation-us") {
    reason = `requires visa sponsorship (${elig.reason}) — sponsorship roles are opt-in`;
  }
  if (!reason) {
    const fit = checkFit(corpus, { title: meta.roleTitle, descriptionText: description });
    if (!fit.ok) reason = `fit/${fit.check}: ${fit.reason}`;
  }
  if (!reason) {
    const lang = checkLanguages(corpus, meta.roleTitle, description);
    if (!lang.ok) reason = lang.reason;
  }

  if (reason) rejected.push({ folder, meta, reason });
  else kept++;
}

console.log(`${kept} kept · ${rejected.length} filtered\n`);
for (const r of rejected) {
  console.log(`  ✗ [${r.meta.score}] ${r.meta.company} — ${r.meta.roleTitle}`);
  console.log(`      ${r.reason}`);
}

if (apply && rejected.length > 0) {
  await mkdir(FILTERED, { recursive: true });
  for (const r of rejected) {
    const from = join(APPLICATIONS_DIR, r.folder);
    const to = join(FILTERED, r.folder);
    await Bun.write(
      join(from, "FILTERED.md"),
      [
        `# Filtered — ${r.meta.company} — ${r.meta.roleTitle}`,
        "",
        `**Reason:** ${r.reason}`,
        "",
        `Filtered ${new Date().toISOString().slice(0, 16)} by scripts/audit-batch.ts.`,
        "Nothing was sent. To reinstate, move this folder back to Applications/.",
        "",
      ].join("\n"),
    );
    await rename(from, to);
  }
  await rebuildLedgerView();
  console.log(`\nmoved ${rejected.length} to Applications/_filtered/`);
}
