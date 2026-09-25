#!/usr/bin/env bun
/**
 * Readiness from a dry-run log: which applications would submit cleanly, and
 * what blocks the rest.
 *
 * A live run refuses to click Submit while any required field is unanswered,
 * but a refusal still costs that company's 24h cooldown. Reading the dry run
 * first means only forms already known to be complete are sent.
 *
 *   bun run scripts/readiness.ts logs/dryrun-greenhouse.log[,logs/other.log]
 */

const logs = (process.argv[2] ?? "").split(",").filter(Boolean);
if (logs.length === 0) {
  console.error("usage: bun run scripts/readiness.ts <dry-run log>[,<log>...]");
  process.exit(1);
}

const BLOCKER = /✗ \[|ERRO:|no option matched|did not register|no suggestion|escalated/;

for (const log of logs) {
  const text = await Bun.file(log).text();
  for (const block of text.split(/\n(?=(?:✓ ENVIADA|✗ ERRO|· preenchida))/)) {
    const head = block.split("\n")[0]!;
    if (!/preenchida|ERRO/.test(head)) continue;
    const blockers = block.split("\n").filter((l) => BLOCKER.test(l)).map((l) => l.trim().slice(0, 160));
    console.log(`${blockers.length === 0 ? "READY  " : "BLOCKED"} ${head.replace(/^(· preenchida \(dry-run\)|✗ ERRO)\s+/, "")}`);
    for (const b of blockers) console.log(`         ${b}`);
  }
}
