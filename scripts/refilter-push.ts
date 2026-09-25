#!/usr/bin/env bun
/**
 * Re-apply the current gates to applications still
 * `prepared`: US roles must be entry-level, and no posting may require US
 * citizenship or a security clearance. Failures are MOVED, never deleted, to
 * Applications/_filtered/<folder>/ with FILTERED.md naming the reason.
 *
 *   bun run scripts/refilter-push.ts            # report
 *   bun run scripts/refilter-push.ts --apply    # move failures
 */
import { join } from "node:path";
import { readdir, rename, mkdir } from "node:fs/promises";
import { loadCorpus } from "../src/corpus/load.ts";
import { APPLICATIONS_DIR, rebuildLedgerView, type ApplicationMeta } from "../src/ledger/ledger.ts";
import { checkFit } from "../src/pipeline/fit.ts";
import { classifyEligibility } from "../src/pipeline/eligibility.ts";
import { isEntryLevel, withinTargetLevel } from "../src/pipeline/level.ts";

const apply = process.argv.includes("--apply");
const corpus = await loadCorpus();
const moved: string[] = [];
let kept = 0;
for (const folder of (await readdir(APPLICATIONS_DIR)).sort()) {
  if (folder.startsWith("_")) continue;
  const meta = (await Bun.file(join(APPLICATIONS_DIR, folder, "meta.json")).json().catch(() => null)) as ApplicationMeta | null;
  if (!meta || meta.status !== "prepared") continue;
  const jd = await Bun.file(join(APPLICATIONS_DIR, folder, "job-description.md")).text().catch(() => "");
  const description = jd.split(/\n---\n/).slice(1).join("\n---\n") || jd;
  let reason: string | null = null;
  if (process.argv.includes("--focus-only") && (meta.eligibilityPath === "relocation-us" || meta.requiresSponsorship) && !isEntryLevel(meta.roleTitle)) reason = "needs a work visa and is above entry level — sponsored roles are junior-only";
  // Eligibility changes with the candidate's stated policy (home cities and
  // relocation list in preferences.yaml), so it is re-judged too.
  const elig = classifyEligibility({ title: meta.roleTitle, locationRaw: meta.locationRaw, remotePolicy: meta.remotePolicy, descriptionText: description } as any);
  if (!reason && !elig.eligible) reason = `eligibility: ${elig.reason}`;
  // The level focus orders the manual index; it no longer removes anything by
  // default. Only --focus-only re-applies it here.
  const lvl = withinTargetLevel(meta.roleTitle);
  if (!reason && !lvl.ok && process.argv.includes("--focus-only")) reason = `level: ${lvl.reason}`;
  const fit = checkFit(corpus, { title: meta.roleTitle, descriptionText: description });
  if (!reason && !fit.ok) reason = `fit/${fit.check}: ${fit.reason}`;
  if (!reason) { kept++; continue; }
  moved.push(`${meta.company} — ${meta.roleTitle}: ${reason}`);
  if (apply) {
    await mkdir(join(APPLICATIONS_DIR, "_filtered"), { recursive: true });
    await Bun.write(join(APPLICATIONS_DIR, folder, "FILTERED.md"), `# Filtered — ${meta.company} — ${meta.roleTitle}\n\n**Reason:** ${reason}\n\nFiltered ${new Date().toISOString().slice(0, 16)} by scripts/refilter-push.ts. Nothing was sent.\n`);
    await rename(join(APPLICATIONS_DIR, folder), join(APPLICATIONS_DIR, "_filtered", folder));
  }
}
if (apply) await rebuildLedgerView();
console.log(`${kept} kept · ${moved.length} ${apply ? "moved to _filtered" : "would be filtered"}`);
for (const m of moved) console.log(`  ✗ ${m.slice(0, 180)}`);
