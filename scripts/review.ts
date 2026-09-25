#!/usr/bin/env bun
/**
 * Review index — the page the candidate reads before approving a batch.
 *
 * One row per prepared application with direct links to the CV, the cover
 * letter and the job snapshot, plus the facts that decide whether to send:
 * score, lane, whether a visa is needed, document language, and the gaps the
 * interviewer is likely to probe. Approval is by id, so nothing is sent that
 * was not explicitly picked.
 *
 *   bun run scripts/review.ts
 */

import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { APPLICATIONS_DIR, loadApplications, type ApplicationMeta } from "../src/ledger/ledger.ts";
import { PROJECT_ROOT } from "../src/corpus/load.ts";

const apps = await loadApplications();
const folderById = new Map<string, string>();
for (const entry of await readdir(APPLICATIONS_DIR)) {
  if (entry.startsWith("_")) continue;
  const f = Bun.file(join(APPLICATIONS_DIR, entry, "meta.json"));
  if (await f.exists()) folderById.set(((await f.json()) as ApplicationMeta).id, entry);
}

const LANE: Record<string, string> = {
  "remote-brazil-eligible": "🇧🇷 remoto",
  "relocation-europe": "🇪🇺 UE",
  "relocation-us": "🇺🇸 EUA",
  "brazil-local": "🇧🇷 presencial/híbrido",
};

const gapsFor = async (folder: string): Promise<string[]> => {
  const r = await Bun.file(join(APPLICATIONS_DIR, folder, "match-report.json")).json().catch(() => null);
  return (r?.gaps ?? []).slice(0, 5);
};

const row = async (a: ApplicationMeta) => {
  const folder = folderById.get(a.id);
  if (!folder) return null;
  const base = `Applications/${folder}`;
  const gaps = await gapsFor(folder);
  const visa = a.requiresSponsorship ? " · **visto**" : "";
  return [
    `| ${a.score} | **${a.company}** — ${a.roleTitle} | ${a.locationRaw.slice(0, 40)} | ${LANE[a.eligibilityPath ?? ""] ?? "-"}${visa} | ${a.lang ?? "en"} | \`${a.angle}\` | ${gaps.join(", ") || "—"} |`,
    `| | [CV](${base}/${a.cvFile}) · [carta](${base}/${a.letterFile}) · [vaga](${base}/job-description.md) · [anúncio](${a.url}) | | | | | \`${a.id}\` |`,
  ].join("\n");
};

const prepared = apps.filter((a) => a.status === "prepared").sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
const pending = apps.filter((a) => a.status === "unconfirmed" || a.status === "approved");
const sent = apps.filter((a) => a.status === "submitted");

const lines: string[] = [];
lines.push("# Revisão de candidaturas");
lines.push("");
lines.push(`> Gerado ${new Date().toISOString().slice(0, 16).replace("T", " ")}. ${prepared.length} prontas para revisão · ${sent.length} enviadas · ${pending.length} pendentes de verificação.`);
lines.push(">");
lines.push("> **Para aprovar:** me diga os IDs, ou rode `bun run src/cli.ts approve <id>,<id>`.");
lines.push("> Só candidaturas aprovadas são enviadas. Filtradas ficam em `Applications/_filtered/` com o motivo.");
lines.push("");

if (sent.length) {
  lines.push("## Enviadas e confirmadas");
  lines.push("");
  for (const a of sent) lines.push(`- **${a.company}** — ${a.roleTitle} · ${a.submittedAt?.slice(0, 10)} · ${a.notes.filter((n) => n.startsWith("confirmed")).at(-1) ?? ""}`);
  lines.push("");
}

if (pending.length) {
  lines.push("## Pendentes — precisam de você");
  lines.push("");
  for (const a of pending) {
    const last = a.notes.at(-1) ?? "";
    lines.push(`- **${a.company}** — ${a.roleTitle} · \`${a.status}\` · ${last.slice(0, 160)}`);
  }
  lines.push("");
}

lines.push("## Prontas para revisão");
lines.push("");
lines.push("| score | vaga | local | lane | idioma | ângulo | gaps prováveis na entrevista |");
lines.push("|---:|---|---|---|---|---|---|");
for (const a of prepared) {
  const r = await row(a);
  if (r) lines.push(r);
}
lines.push("");

const out = join(PROJECT_ROOT, "REVIEW.md");
await Bun.write(out, lines.join("\n"));
console.log(`${prepared.length} prontas · ${sent.length} enviadas · ${pending.length} pendentes → ${out}`);
