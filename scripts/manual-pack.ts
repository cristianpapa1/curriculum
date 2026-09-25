#!/usr/bin/env bun
/**
 * Manual submission packs.
 *
 * Some boards cannot be submitted automatically, and must not be: Lever forms
 * carry an hCaptcha challenge, and SmartRecruiters runs
 * its apply flow in a separate app. For those, everything is prepared so that
 * submitting by hand takes a few minutes: the apply link, the exact files, and
 * every answer — standard fields, salary, and the form-specific answers in
 * answers.json — written to MANUAL-SUBMIT.md in the application folder.
 *
 *   bun run scripts/manual-pack.ts            # lever + smartrecruiters, approved
 *   bun run scripts/manual-pack.ts --ats lever
 */

import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { loadCorpus } from "../src/corpus/load.ts";
import { APPLICATIONS_DIR, type ApplicationMeta } from "../src/ledger/ledger.ts";
import { loadCredentials } from "../src/pipeline/credentials.ts";
import { answerSalary } from "../src/pipeline/compensation.ts";
import { applyUrlFor } from "../src/pipeline/submit.ts";
import { relevantCertifications, certificationsText, signalsForFolder } from "../src/pipeline/certifications.ts";
import { withinTargetLevel } from "../src/pipeline/level.ts";
import { inHomeArea } from "../src/pipeline/eligibility.ts";

const atsArg = process.argv[process.argv.indexOf("--ats") + 1];
const boards = new Set(process.argv.includes("--ats") && atsArg ? atsArg.split(",") : ["lever", "smartrecruiters", "gupy", "ashby"]);
const corpus = await loadCorpus();
const creds = await loadCredentials();
const id = corpus.profile.identity;
const index: string[] = [];
const rows: { score: number; line: string; inFocus: boolean }[] = [];

for (const folder of (await readdir(APPLICATIONS_DIR)).sort()) {
  if (folder.startsWith("_")) continue;
  const dir = join(APPLICATIONS_DIR, folder);
  const meta = (await Bun.file(join(dir, "meta.json")).json().catch(() => null)) as ApplicationMeta | null;
  if (!meta || meta.status !== "approved" || !boards.has(meta.atsType)) continue;

  const answers = (await Bun.file(join(dir, "answers.json")).json().catch(() => [])) as { q: string; a: string | string[]; why?: string }[];
  // A number: the low anchor for the region and role. When the form's chosen
  // office is the candidate's home city, "local currency" means the home
  // currency per month — found on a form where a monthly figure sat beside an
  // "Annual" label for a Brazilian office.
  const first = (a: { a: string | string[] }) => (Array.isArray(a.a) ? a.a[0]! : a.a);
  const home = id.location ?? "";
  const atHome = answers.some((a) => inHomeArea(first(a)) && !/current location/i.test(a.q));
  const salary = answerSalary(atHome ? home : meta.locationRaw, "", { title: meta.roleTitle, numberRequired: true, preferAvoidance: false, lang: (meta.lang as any) ?? "en" });
  const certs = certificationsText(relevantCertifications(corpus, await signalsForFolder(dir, meta.roleTitle)));
  const letter = (await Bun.file(join(dir, "CoverLetter.md")).text().catch(() => "")).split(/\n\n/).slice(2).join("\n\n").trim();
  const why = meta.atsType === "lever"
    ? "Lever's invisible hCaptcha rejected an automated submission (\"There was an error verifying your application\"), so Lever forms are submitted by hand."
    : meta.atsType === "gupy"
      ? "Gupy applications need a candidate login and a multi-step flow (often with profile tests), so they are submitted by hand."
      : meta.atsType === "ashby"
        ? "Ashby flags automated submissions as possible spam, and its own advice is to switch network or browser — which is bot-protection evasion, so Ashby forms are submitted by hand."
        : "SmartRecruiters' apply app sits behind DataDome bot protection, so it is submitted by hand.";

  const md = [
    `# Submit by hand — ${meta.company} — ${meta.roleTitle}`,
    ``,
    `> ${why} Everything below is prepared; nothing here was sent.`,
    ``,
    `**Apply:** ${applyUrlFor(meta)}`,
    ``,
    `## Files`,
    `- CV: \`${join(dir, meta.cvFile)}\``,
    `- Cover letter: \`${join(dir, meta.letterFile)}\``,
    ``,
    `## Standard fields`,
    `| Field | Answer |`,
    `|---|---|`,
    `| Full name | ${creds.fullName} |`,
    `| Email | ${creds.email} |`,
    `| Phone | ${creds.phone} |`,
    `| Current location | ${home} — pick the suggestion naming your city and country |`,
    `| Current company | ${corpus.profile.employment.find((e) => e.current)?.employer ?? ""} |`,
    `| LinkedIn | ${id.linkedin ?? creds.linkedin} |`,
    `| GitHub | ${id.github} |`,
    `| Website / portfolio | ${id.hub ?? id.website} |`,
    `| Salary expectation | ${salary.numeric ?? salary.value} ${salary.currency} per ${salary.period} (low anchor for ${salary.region}) |`,
    `| Sponsorship needed | ${meta.requiresSponsorship ? "Yes" : "No"} |`,
    `| How did you hear | LinkedIn (never "referral") |`,
    // Only certifications related to this posting; none related → not mentioned.
    ...(certs ? [`| Certifications (related to this role) | ${certs} |`] : []),
    ``,
    ...(answers.length
      ? [`## This form's own questions`, `| Question (fragment) | Answer | Why |`, `|---|---|---|`,
         ...answers.map((a) => {
           // The salary-period answer follows the figure shown above, never the reverse.
           const period = /salary expectations are/i.test(a.q);
           const shown = period ? (salary.period === "month" ? "Monthly" : "Annual") : first(a);
           const reason = period ? `matches the salary figure (${salary.currency} per ${salary.period})` : a.why ?? "";
           return `| ${a.q} | ${shown.replace(/\|/g, "/")} | ${reason} |`;
         }), ``]
      : []),
    ...(letter ? [`## Cover letter text (for an "additional information" box)`, ``, letter, ``] : []),
  ].join("\n");

  await Bun.write(join(dir, "MANUAL-SUBMIT.md"), md);
  index.push(`- [${meta.company} — ${meta.roleTitle}](Applications/${folder}/MANUAL-SUBMIT.md) · ${meta.atsType}`);
  rows.push({
    inFocus: withinTargetLevel(meta.roleTitle).ok,
    score: meta.score ?? 0,
    line: `| ${meta.score ?? "–"} | ${meta.atsType} | [${`${meta.company} — ${meta.roleTitle}`.replace(/\|/g, "/")}](Applications/${folder}/MANUAL-SUBMIT.md) | ${meta.locationRaw.replace(/\|/g, "/")} |`,
  });
}

// One index for all of them, best match first, so the hand-submitted ones are
// worked through in order of fit rather than by board.
// Split by the candidate's target level per field (targeting.focus_levels): the
// rest stays listed below, since volume can matter more than focus.
rows.sort((a, b) => b.score - a.score);
const table = (list: typeof rows) => [`| Score | Board | Role | Location |`, `|---|---|---|---|`, ...list.map((r) => r.line)];
const focus = rows.filter((r) => r.inFocus);
const outside = rows.filter((r) => !r.inFocus);
await Bun.write(join(APPLICATIONS_DIR, "..", "MANUAL-INDEX.md"), [
  `# Applications to submit by hand`,
  ``,
  `${rows.length} prepared and approved. Each link opens a pack with the apply URL, the files and every answer.`,
  ``,
  `## In focus — ${focus.length}`,
  ``,
  `At the level you target in each field (preferences.yaml, targeting.focus_levels). Ordered by match score: start at the top.`,
  ``,
  ...table(focus),
  ``,
  `## Outside the focus — ${outside.length}`,
  ``,
  `Above the level you target in their field. Still worth sending when volume matters more than focus.`,
  ``,
  ...table(outside),
  ``,
].join("\n"));
console.log(`${index.length} manual packs written`);
for (const line of index) console.log(line);
