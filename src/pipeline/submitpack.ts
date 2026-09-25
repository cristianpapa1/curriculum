/**
 * Submission pack.
 *
 * Automated submission needs Interceptor driving real Chrome, and Interceptor
 * is not installed on this machine (no CLI, no daemon, and the skill expects
 * macOS paths while this is WSL with Chrome on the Windows side). Playwright is
 * not the fallback: ATS bot detection soft-fails headless submissions, so the
 * form looks submitted and nothing arrives — worse than not applying.
 *
 * So this produces the next best thing: everything needed to submit each
 * application by hand in a couple of minutes instead of twenty. Direct link,
 * the exact files to attach, every standard form answer pre-computed, the
 * salary answer for that region and seniority, and the gaps worth expecting a
 * question about.
 *
 * Deliberately NOT a substitute for the submit bridge — it is what makes the
 * work shippable while the bridge does not exist.
 */

import { join } from "node:path";
import type { Corpus } from "../corpus/types.ts";
import { loadApplications, APPLICATIONS_DIR, type ApplicationMeta } from "../ledger/ledger.ts";
import { readdir } from "node:fs/promises";
import { standardAnswers, eeoAnswers } from "./formanswers.ts";
import { answerSalary } from "./compensation.ts";
import { PROJECT_ROOT } from "../corpus/load.ts";

/**
 * The country the work would actually be performed from.
 *
 * This is NOT the posting's location string. For a remote role open to Brazil,
 * the work happens in Brazil and the candidate is authorized there — answering "not
 * authorized" because the posting says "Remote, Global" is a false statement
 * against himself and an automatic rejection.
 */
function countryOf(meta: ApplicationMeta): string {
  // A remote role the candidate is eligible for is worked from home, full stop.
  if (meta.eligibilityPath === "remote-brazil-eligible") return "Brazil";

  const loc = meta.locationRaw ?? "";
  if (/brazil|brasil|são paulo/i.test(loc)) return "Brazil";
  if (/finland|helsinki/i.test(loc)) return "Finland";
  if (/ireland|dublin/i.test(loc)) return "Ireland";
  if (/portugal|lisbon/i.test(loc)) return "Portugal";
  if (/netherlands|amsterdam/i.test(loc)) return "Netherlands";
  if (/germany|berlin|munich/i.test(loc)) return "Germany";
  if (/france|paris/i.test(loc)) return "France";
  if (/spain|madrid|valencia/i.test(loc)) return "Spain";
  if (/united kingdom|london/i.test(loc)) return "United Kingdom";
  if (/san francisco|united states|\bus\b|new york|seattle/i.test(loc)) return "United States";
  if (/global|worldwide|anywhere/i.test(loc)) return "Remote (global)";
  return loc || "unknown";
}

export async function buildSubmitPack(
  corpus: Corpus,
  opts: { applicationsDir?: string; outFile?: string } = {},
): Promise<{ file: string; count: number }> {
  const apps = (await loadApplications(opts.applicationsDir ?? APPLICATIONS_DIR))
    .filter((a) => a.status === "prepared")
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  // Map each record to the directory that actually holds it. Rebuilding the
  // folder name from the metadata drifts the moment slugify changes, and a
  // wrong path in a submission pack means attaching the wrong file.
  const dirById = new Map<string, string>();
  for (const entry of await readdir(opts.applicationsDir ?? APPLICATIONS_DIR)) {
    const f = Bun.file(join(opts.applicationsDir ?? APPLICATIONS_DIR, entry, "meta.json"));
    if (!(await f.exists())) continue;
    try {
      dirById.set(((await f.json()) as ApplicationMeta).id, entry);
    } catch { /* a corrupt record is reported by loadApplications */ }
  }

  const out: string[] = [];
  out.push("# Submission pack");
  out.push("");
  out.push(
    `> ${apps.length} applications ready to send, highest match first. Generated ` +
      `${new Date().toISOString().slice(0, 16).replace("T", " ")}.`,
  );
  out.push(">");
  out.push(
    "> Automated submission is not wired yet (Interceptor is not installed on this",
  );
  out.push(
    "> machine). Everything below is pre-computed so each one takes a couple of",
  );
  out.push("> minutes by hand. After sending, run:");
  out.push("> `bun run src/cli.ts mark <ats:jobId> submitted`");
  out.push("");
  out.push("---");
  out.push("");

  for (const [i, a] of apps.entries()) {
    const folder = dirById.get(a.id);
    if (!folder) continue; // record without a folder on disk — skip rather than emit a bad path
    const dir = join("Applications", folder);
    const country = countryOf(a);
    const answers = standardAnswers(corpus, {
      country,
      companyName: a.company,
      atsType: a.atsType,
    });
    const salaryText = answerSalary(a.locationRaw, "", {
      title: a.roleTitle,
      acceptsText: true,
      lang: (a.lang as "en" | "pt" | "es") ?? "en",
    });
    const salaryNum = answerSalary(a.locationRaw, "", {
      title: a.roleTitle,
      numberRequired: true,
    });

    out.push(`## ${i + 1}. ${a.company} — ${a.roleTitle}`);
    out.push("");
    out.push(`**Apply:** ${a.url}`);
    out.push("");
    out.push(
      `\`${a.atsType}\` · match **${a.score}** · angle \`${a.angle}\` · ${a.locationRaw} · ` +
        `${a.eligibilityPath ?? "-"}${a.requiresSponsorship ? " **(needs sponsorship)**" : ""} · docs in ${a.lang ?? "en"}`,
    );
    out.push("");
    out.push("**Attach**");
    out.push(`- CV: \`${dir}/${a.cvFile}\``);
    out.push(`- Cover letter: \`${dir}/${a.letterFile}\``);
    out.push("");
    out.push("**Form answers**");
    out.push("");
    out.push("| question | answer |");
    out.push("|---|---|");
    for (const ans of answers) {
      out.push(`| ${ans.question} | **${ans.value}** |`);
    }
    for (const ans of eeoAnswers(corpus)) {
      out.push(`| ${ans.question} | ${ans.value} |`);
    }
    out.push(
      `| Salary expectation (text field) | ${salaryText.value} |`,
    );
    out.push(
      `| Salary expectation (number required) | ${salaryNum.currency} ${salaryNum.numeric?.toLocaleString("en-US")}${salaryNum.period === "month" ? "/month" : "/year"} |`,
    );
    out.push("");

    if (a.requiresSponsorship) {
      out.push(
        "> ⚠️ This role needs visa sponsorship. Answer the authorization questions " +
          "truthfully as above — a false answer here can void an offer after acceptance.",
      );
      out.push("");
    }

    out.push("**Expect to be asked about** (requirements with no evidence in the corpus)");
    out.push("");
    const report = await Bun.file(join(PROJECT_ROOT, dir, "match-report.json")).json().catch(() => null);
    const gaps: string[] = report?.gaps ?? [];
    out.push(gaps.length > 0 ? gaps.slice(0, 10).map((g) => `\`${g}\``).join(" · ") : "_none detected_");
    out.push("");
    out.push("---");
    out.push("");
  }

  const file = opts.outFile ?? join(PROJECT_ROOT, "SUBMIT.md");
  await Bun.write(file, out.join("\n"));
  return { file, count: apps.length };
}
