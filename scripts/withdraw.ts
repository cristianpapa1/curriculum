#!/usr/bin/env bun
/**
 * Withdraw applications that are not yet sent, with a recorded reason.
 *
 *   bun run scripts/withdraw.ts "<company regex>" "<reason>" [--title "<regex>"]
 */
import { loadApplications, updateStatus } from "../src/ledger/ledger.ts";
const [companyRe, reason] = process.argv.slice(2);
const ti = process.argv.indexOf("--title");
const titleRe = ti > -1 ? new RegExp(process.argv[ti + 1]!, "i") : null;
if (!companyRe || !reason) { console.error('usage: withdraw.ts "<company regex>" "<reason>" [--title "<regex>"]'); process.exit(1); }
const now = new Date().toISOString().slice(0, 16);
for (const a of await loadApplications()) {
  if (!["prepared", "approved"].includes(a.status)) continue;
  if (!new RegExp(companyRe, "i").test(a.company)) continue;
  if (titleRe && !titleRe.test(a.roleTitle)) continue;
  await updateStatus(a.id, { status: "withdrawn", notes: [...a.notes, `${now} withdrawn — ${reason}`] });
  console.log("withdrawn:", a.company, "—", a.roleTitle);
}
