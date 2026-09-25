#!/usr/bin/env bun
/**
 * Re-render application documents with the current renderers.
 *
 * Renderers improve after a batch is prepared; this brings every application
 * that has NOT been sent (prepared / approved) up to date, in place, keeping
 * its folder, file names, angle and status. The job is re-scored from the saved
 * posting so bullets follow the posting's requirements. Every document passes
 * the anti-fabrication gate again before it is written — a failure leaves that
 * application's files untouched.
 *
 *   bun run scripts/rerender.ts              # report only
 *   bun run scripts/rerender.ts --apply      # rewrite md, html, pdf
 *   bun run scripts/rerender.ts --apply --only <id>,<id>
 */

import { join } from "node:path";
import { readdir, mkdir, copyFile } from "node:fs/promises";
import { loadCorpus } from "../src/corpus/load.ts";
import { APPLICATIONS_DIR, updateStatus, type ApplicationMeta } from "../src/ledger/ledger.ts";
import { scoreJob } from "../src/pipeline/score.ts";
import { classifyEligibility } from "../src/pipeline/eligibility.ts";
import { chooseLocale } from "../src/render/locale.ts";
import { renderCV } from "../src/render/cv.ts";
import { renderLetter } from "../src/render/letter.ts";
import { postingSignals } from "../src/pipeline/certifications.ts";
import { htmlToPdf } from "../src/render/pdf.ts";
import { checkAntiFabrication, formatViolations } from "../src/position/antifab.ts";

const apply = process.argv.includes("--apply");
const onlyArg = process.argv[process.argv.indexOf("--only") + 1];
const only = process.argv.includes("--only") && onlyArg ? new Set(onlyArg.split(",")) : null;
const corpus = await loadCorpus();

let ok = 0;
const failed: string[] = [];

for (const folder of (await readdir(APPLICATIONS_DIR)).sort()) {
  if (folder.startsWith("_")) continue;
  const dir = join(APPLICATIONS_DIR, folder);
  const metaFile = Bun.file(join(dir, "meta.json"));
  if (!(await metaFile.exists())) continue;
  const meta = (await metaFile.json()) as ApplicationMeta;
  if (meta.status !== "prepared" && meta.status !== "approved") continue;
  if (only && !only.has(meta.id)) continue;

  const jd = await Bun.file(join(dir, "job-description.md")).text();
  const description = jd.split(/\n---\n/).slice(1).join("\n---\n") || jd;
  const job = {
    id: meta.jobId, atsType: meta.atsType as any, companyToken: meta.company, title: meta.roleTitle,
    url: meta.url, locationRaw: meta.locationRaw, remotePolicy: meta.remotePolicy as any,
    descriptionText: description, fetchedAt: meta.preparedAt,
  };

  try {
    const score = scoreJob(corpus, job, meta.angle);
    const elig = classifyEligibility(job);
    const showWorkAuthorization = elig.path === "relocation-europe" && !elig.requiresSponsorship;
    const locale = chooseLocale(job);
    const requiredSkills = score.matches.filter((m) => m.matched).map((m) => m.term);

    const cv = renderCV(corpus, meta.angle, {
      targetTitle: meta.roleTitle, lang: locale.lang, showWorkAuthorization, requiredSkills, requirements: score.matches,
      postingSignals: postingSignals(meta.roleTitle, score.matches.map((m) => m.term)),
    });
    const letter = renderLetter(corpus, meta.angle, {
      company: meta.company, roleTitle: meta.roleTitle, locationRaw: meta.locationRaw,
      lang: locale.lang, requirements: score.matches, showWorkAuthorization,
      postingSignals: postingSignals(meta.roleTitle, score.matches.map((m) => m.term)),
    });
    for (const [label, doc] of [["CV", cv], ["cover letter", letter]] as const) {
      const gate = checkAntiFabrication(doc.markdown, corpus);
      if (!gate.ok) throw new Error(`anti-fabrication gate rejected the ${label}: ${formatViolations(gate.violations)}`);
    }

    const cvBase = meta.cvFile.replace(/\.pdf$/, "");
    console.log(`✓ [${score.score}] ${meta.company} — ${meta.roleTitle} (${cv.lang}, angle ${meta.angle}${score.suggestedAngle !== meta.angle ? `, suggested ${score.suggestedAngle}` : ""})`);

    if (apply) {
      // Keep the version the candidate reviewed, so the change is inspectable.
      const prev = join(dir, "previous-draft");
      await mkdir(prev, { recursive: true });
      // Only the first re-render saves a copy; later runs must not overwrite
      // the reviewed version with an intermediate one.
      for (const f of [`${cvBase}.md`, "CoverLetter.md"]) {
        const saved = join(prev, f);
        if ((await Bun.file(join(dir, f)).exists()) && !(await Bun.file(saved).exists())) {
          await copyFile(join(dir, f), saved);
        }
      }
      await Bun.write(join(dir, `${cvBase}.md`), cv.markdown);
      await Bun.write(join(dir, `${cvBase}.html`), cv.html);
      await Bun.write(join(dir, "CoverLetter.md"), letter.markdown);
      await Bun.write(join(dir, "CoverLetter.html"), letter.html);
      await Bun.write(join(dir, "match-report.json"), JSON.stringify(score, null, 2));
      await htmlToPdf(cv.html, join(dir, `${cvBase}.pdf`));
      await htmlToPdf(letter.html, join(dir, "CoverLetter.pdf"));
      await updateStatus(meta.id, {
        score: score.score,
        claimIds: [...new Set([...cv.claimIds, ...letter.claimIds])],
        lang: cv.lang,
        notes: [...(meta.notes ?? []), `${new Date().toISOString().slice(0, 16)} documents re-rendered against posting requirements`],
      });
    }
    ok++;
  } catch (err) {
    failed.push(`${meta.company} — ${meta.roleTitle}: ${(err as Error).message.split("\n")[0]}`);
  }
}

console.log(`\n${ok} rendered${apply ? " and written" : ""} · ${failed.length} failed`);
for (const f of failed) console.log(`  ✗ ${f}`);
