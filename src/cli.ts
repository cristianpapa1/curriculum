#!/usr/bin/env bun
/**
 * Curriculum CLI — the trigger surface.
 *
 * Every run is explicitly invoked; there is no scheduler and no daemon
 * (ISC-38). Autonomy lives INSIDE a run, not across time.
 *
 *   bun run src/cli.ts angles
 *   bun run src/cli.ts project iam
 *   bun run src/cli.ts scan greenhouse:elastic ashby:supabase
 *   bun run src/cli.ts prepare --angle iam --targets greenhouse:elastic --limit 3
 *   bun run src/cli.ts ledger
 */

import { loadCorpus } from "./corpus/load.ts";
import { listAngles } from "./position/angles.ts";
import { project } from "./position/project.ts";
import { adapters } from "./ats/index.ts";
import { isBrazilEligible } from "./ats/remote.ts";
import { scoreJob } from "./pipeline/score.ts";
import { prepareApplications, type Target } from "./pipeline/prepare.ts";
import { rebuildLedgerView, loadApplications, analyseByAngle } from "./ledger/ledger.ts";
import { registryTargets, loadRegistry, recordScan } from "./pipeline/registry.ts";
import { buildSubmitPack } from "./pipeline/submitpack.ts";
import { submitApplications } from "./pipeline/submit.ts";
import { updateStatus } from "./ledger/ledger.ts";
import { onboardingRecord } from "./pipeline/onboarding.ts";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseTargets(spec: string): Target[] {
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [atsType, token] = s.split(":");
      if (!atsType || !token) throw new Error(`bad target "${s}" — use <ats>:<token>`);
      return { atsType, token };
    });
}

const command = process.argv[2];

switch (command) {
  case "angles": {
    console.log("Positioning angles (pass any of these, or free text):\n");
    for (const a of listAngles()) console.log(`  ${a}`);
    break;
  }

  case "project": {
    const corpus = await loadCorpus();
    const angle = process.argv[3] ?? null;
    const limit = Number(flag("limit", "10"));
    const result = project(corpus, angle, { limit });
    console.log(
      `angle "${angle ?? "(none)"}" → ${result.angle?.label ?? "NONE (strength fallback)"}\n`,
    );
    for (const [i, p] of result.claims.entries()) {
      console.log(`${String(i + 1).padStart(2)}. [${p.score.toFixed(1)}] ${p.claim.id} (${p.variantUsed})`);
      console.log(`    ${p.text.replace(/\s+/g, " ").slice(0, 160)}`);
    }
    break;
  }

  case "scan": {
    let specs = process.argv.slice(3).filter((a) => !a.startsWith("--"));

    if (has("from-registry")) {
      const { targets, skipped } = await registryTargets({
        match: flag("match"),
        ats: flag("ats")?.split(","),
        limit: Number(flag("registry-limit", "40")),
        staleAfterHours: flag("stale-after") ? Number(flag("stale-after")) : undefined,
        rotate: !has("by-size"),
      });
      specs = targets.map((t) => `${t.atsType}:${t.token}`);
      console.log(`registry → ${specs.length} boards`);
      for (const s of skipped) console.log(`    (${s.count} skipped: ${s.reason})`);
    }

    if (specs.length === 0) {
      console.error("usage: scan <ats>:<token> [...]  |  scan --from-registry");
      process.exit(1);
    }
    const scanResults: { atsType: string; token: string; jobsTotal: number; jobsEligible: number }[] = [];
    for (const spec of specs) {
      const [ats, token] = spec.split(":");
      const adapter = ats ? adapters[ats] : undefined;
      if (!adapter || !token) {
        console.log(`${spec}: unknown ATS "${ats}"`);
        continue;
      }
      try {
        const jobs = await adapter.fetchJobs(token);
        const eligible = jobs.filter((j) => isBrazilEligible(j).eligible);
        scanResults.push({ atsType: ats!, token: token!, jobsTotal: jobs.length, jobsEligible: eligible.length });
        console.log(
          `${spec}: ${jobs.length} jobs, ${eligible.length} Brazil-eligible`,
        );
        for (const j of eligible.slice(0, 8)) {
          console.log(`    → ${j.title} @ ${j.locationRaw}`);
        }
      } catch (err) {
        console.log(`${spec}: ERROR ${(err as Error).message}`);
      }
    }
    // Feed results back so the registry gets better with every run.
    if (scanResults.length > 0) {
      const n = await recordScan(scanResults);
      console.log(`\nregistry updated: ${n} boards`);
    }
    break;
  }

  case "prepare": {
    const corpus = await loadCorpus();
    const targetSpec = flag("targets");
    let targets;

    if (has("from-registry")) {
      // The registry is the whole point of Companies/: a run should use the
      // boards already found rather than a hand-typed list.
      const { targets: fromReg, skipped } = await registryTargets({
        match: flag("match"),
        ats: flag("ats")?.split(","),
        limit: Number(flag("registry-limit", "25")),
        rotate: !has("by-size"),
      });
      targets = fromReg;
      console.log(`registry → ${targets.length} boards`);
      for (const s of skipped) console.log(`    (${s.count} skipped: ${s.reason})`);
      if (targets.length === 0) {
        console.error("no resolved boards matched — run scripts/resolve.ts first");
        process.exit(1);
      }
    } else if (targetSpec) {
      targets = parseTargets(targetSpec);
    } else {
      console.error("prepare requires --targets <ats>:<token>[,...] or --from-registry");
      process.exit(1);
    }
    const angle = flag("angle") ?? null;

    console.log(
      `preparing — angle=${angle ?? "(auto per posting)"} targets=${targets.length} ` +
        `minScore=${flag("min-score", "0")} limit=${flag("limit", "5")} pdf=${!has("no-pdf")}\n`,
    );

    const result = await prepareApplications(corpus, targets, {
      angle,
      minScore: Number(flag("min-score", "0")),
      limit: Number(flag("limit", "5")),
      pdf: !has("no-pdf"),
      ignoreEligibility: has("ignore-eligibility"),
      paths: (flag("paths") ?? "remote-brazil-eligible,relocation-europe").split(",") as any,
      titleMatch: flag("title"),
      perCompanyCap: Number(flag("per-company", "3")),
      allowSponsorship: has("allow-sponsorship"),
      usEntryLevelOnly: has("us-entry-only"),
      focusOnly: has("focus-only"),
    });

    console.log(`fetched ${result.fetched} postings`);
    console.log(`prepared ${result.prepared.length}:\n`);
    for (const p of result.prepared) {
      console.log(`  ✓ [${p.meta.score}] ${p.meta.company} — ${p.meta.roleTitle}`);
      console.log(`      angle=${p.meta.angle}  location="${p.meta.locationRaw}"`);
      console.log(`      ${p.dir}`);
      if (p.score.gaps.length > 0) {
        console.log(`      gaps: ${p.score.gaps.slice(0, 8).join(", ")}`);
      }
    }
    if (result.skipped.length > 0) {
      console.log(`\nskipped ${result.skipped.length}:`);
      for (const s of result.skipped.slice(0, 12)) {
        console.log(`  - ${s.company} / ${s.job}: ${s.reason}`);
      }
    }
    if (result.errors.length > 0) {
      console.log(`\nerrors ${result.errors.length}:`);
      for (const e of result.errors) console.log(`  ! ${e}`);
    }
    break;
  }

  case "registry": {
    const all = await loadRegistry();
    const ready = all.filter((e) => e.atsSupported);
    const probed = all.filter((e) => !e.atsSupported && e.resolveAttemptedAt);
    console.log(`${all.length} companies | ${ready.length} with a resolved board | ${probed.length} probed with none | ${all.length - ready.length - probed.length} unprobed`);
    const byAts = new Map<string, number>();
    for (const e of ready) byAts.set(e.ats!, (byAts.get(e.ats!) ?? 0) + 1);
    console.log("\nby platform:");
    for (const [a, n] of [...byAts].sort((x, y) => y[1] - x[1])) console.log(`  ${a.padEnd(18)} ${n}`);
    const top = [...ready].sort((a, b) => (b.jobsTotal ?? 0) - (a.jobsTotal ?? 0)).slice(0, 15);
    console.log("\nlargest boards:");
    for (const e of top) {
      console.log(`  ${String(e.jobsTotal ?? "-").padStart(5)} roles  ${e.ats}:${e.atsToken}`.padEnd(44) + `  ${e.name}`);
    }
    break;
  }

  case "submit-pack": {
    const corpus = await loadCorpus();
    const { file, count } = await buildSubmitPack(corpus);
    console.log(`${count} applications ready → ${file}`);
    break;
  }

  case "approve": {
    // the candidate's review gate: only approved applications are ever sent live.
    const ids = (process.argv[3] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) {
      console.error("usage: approve <ats:jobId>[,<ats:jobId>...]");
      process.exit(1);
    }
    const on = new Map((await loadApplications()).map((a) => [a.id, a]));
    for (const id of ids) {
      const a = on.get(id);
      if (!a) { console.log(`  ? ${id} — not found`); continue; }
      if (a.status !== "prepared") { console.log(`  · ${a.company} — ${a.roleTitle}: is ${a.status}, left unchanged`); continue; }
      await updateStatus(id, { status: "approved" as any, notes: [...a.notes, `${new Date().toISOString().slice(0, 16)} approved for submission`] });
      console.log(`  ✓ approved: ${a.company} — ${a.roleTitle}`);
    }
    break;
  }

  case "mark": {
    const id = process.argv[3];
    const status = process.argv[4] as any;
    if (!id || !status) {
      console.error("usage: mark <ats:jobId> <submitted|rejected|screening|interview|offer|withdrawn>");
      process.exit(1);
    }
    const updated = await updateStatus(id, {
      status,
      ...(status === "submitted" ? { submittedAt: new Date().toISOString() } : {}),
      ...(["rejected", "screening", "interview", "offer"].includes(status)
        ? { respondedAt: new Date().toISOString(), responseType: status }
        : {}),
    });
    console.log(`${updated.company} — ${updated.roleTitle} → ${updated.status}`);
    break;
  }

  case "submit": {
    const corpus = await loadCorpus();
    const live = has("live");
    // Nothing is sent on someone's behalf before they have answered, once, the
    // questions no CV answers (scripts/onboard.ts). Dry runs stay available.
    if (live && !(await onboardingRecord())) {
      console.error("Live submission is locked until onboarding is complete: run `bun run onboard` (or `bun run onboard --check` to see what is missing).");
      process.exit(1);
    }
    if (live) console.log("⚠️  LIVE — applications will be SENT\n");
    else console.log("dry run (default) — fills every form and sends NOTHING\n");

    const results = await submitApplications(corpus, {
      dryRun: !live,
      headless: !has("show"),
      only: flag("only"),
      exclude: flag("exclude")?.split(","),
      ats: flag("ats")?.split(","),
      limit: Number(flag("limit", "1")),
    });

    for (const r of results) {
      console.log(`\n${r.submitted ? "✓ ENVIADA" : r.error ? "✗ ERRO" : "· preenchida (dry-run)"}  ${r.company} — ${r.roleTitle}`);
      console.log(`   ${r.url}`);
      for (const f of r.fields) {
        const icon = f.action === "BLOCKED" || f.action === "MISSING-REQUIRED" ? "✗" : f.action === "SKIPPED-UNKNOWN" ? "?" : "✓";
        console.log(`   ${icon} [${f.kind}] ${f.label.slice(0, 44).padEnd(44)} ${(f.value ?? "").slice(0, 52)}`);
      }
      if (r.screenshots.length) console.log(`   📸 ${r.screenshots.join("\n   📸 ")}`);
      if (r.error) console.log(`   ERRO: ${r.error}`);
    }
    break;
  }

  case "ledger": {
    await rebuildLedgerView();
    const apps = await loadApplications();
    console.log(`${apps.length} applications on file\n`);
    for (const a of apps.slice(0, 20)) {
      console.log(
        `  ${(a.submittedAt ?? a.preparedAt).slice(0, 10)}  [${String(a.score ?? "-").padStart(3)}]  ` +
          `${a.status.padEnd(12)} ${a.angle ?? "-"}  ${a.company} — ${a.roleTitle}`,
      );
    }
    const stats = analyseByAngle(apps);
    if (stats.length > 0) {
      console.log("\nresponse rate by angle:");
      for (const s of stats) {
        console.log(
          `  ${s.angle.padEnd(14)} sent=${s.sent} replies=${s.replies} rate=${(s.responseRate * 100).toFixed(0)}%`,
        );
      }
    }
    break;
  }

  default:
    console.log(
      [
        "Curriculum — job discovery, CV re-projection and application agent",
        "",
        "  angles                                    list positioning angles",
        "  project <angle> [--limit N]               show the corpus projected toward an angle",
        "  scan <ats>:<token> [...]                  count Brazil-eligible roles on a board",
        "       [--from-registry] [--match X] [--ats greenhouse,ashby] [--registry-limit N]",
        "  registry                                  summarise the company registry",
        "  prepare --targets <ats>:<token>[,...]     discover, score, tailor and file applications",
        "          --from-registry                   ...or pull targets from Companies/registry.yaml",
        "          --title <regex>                   only postings whose title matches",
        "          --paths a,b                       lanes: remote-brazil-eligible, relocation-europe, relocation-us",
        "          [--angle X] [--min-score N] [--limit N] [--no-pdf] [--ignore-eligibility]",
        "  submit [--only <ats:jobId>] [--limit N]   fill a real form (DRY-RUN by default)",
        "         [--live]                           actually submit — irreversible",
        "         [--show]                           run headed so you can watch",
        "  submit-pack                               write SUBMIT.md: links, files and pre-filled answers",
        "  mark <ats:jobId> <status>                 record an outcome (submitted, rejected, interview…)",
        "  ledger                                    rebuild and show the application ledger",
        "",
        `  ATS adapters: ${Object.keys(adapters).join(", ")}`,
      ].join("\n"),
    );
}
