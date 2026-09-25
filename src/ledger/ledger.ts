/**
 * Application ledger.
 *
 * the candidate's requirement: after every application, keep the exact CV that was
 * sent, in a per-application folder, plus a file that always shows what was
 * submitted, when, to which link and title.
 *
 * Design decision worth stating: `meta.json` inside each application folder is
 * the SOURCE OF TRUTH, and `APPLICATIONS.md` is a deterministic VIEW rebuilt
 * from those records. An append-only markdown file drifts the moment anything
 * crashes mid-write or a status later changes; a regenerated view cannot. The
 * folders are the ledger — the markdown is how you read it.
 *
 * Atomicity (ISC-33): everything is written into a staging directory and then
 * renamed into place. A rename on the same filesystem is atomic, so a crash
 * leaves either a complete application folder or nothing at all — never a
 * half-written record that later reads as a real submission.
 */

import { mkdir, rename, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_ROOT } from "../corpus/load.ts";

export type ApplicationStatus =
  | "prepared"      // documents generated, not yet sent
  | "approved"      // the candidate reviewed and approved sending — the ONLY status a live run submits
  | "submitted"     // confirmed submitted with proof
  | "unconfirmed"   // submit was clicked but success was never proven — never auto-resubmitted
  | "failed"        // submission attempt failed
  | "acknowledged"  // automated receipt
  | "screening"     // human contact
  | "interview"
  | "offer"
  | "rejected"
  | "withdrawn";

export interface ApplicationMeta {
  /** Stable id: `${atsType}:${jobId}` — the dedupe key (ISC-37). */
  id: string;
  atsType: string;
  jobId: string;
  company: string;
  roleTitle: string;
  url: string;

  /** Positioning used — the variable whose effect we are measuring. */
  angle: string | null;
  score: number | null;
  claimIds: string[];

  locationRaw: string;
  remotePolicy: string;
  brazilEligible: boolean;
  eligibilityReason: string;
  /** Which policy path admitted this role. */
  eligibilityPath?: string;
  requiresSponsorship?: boolean;
  /** Language the documents were rendered in. */
  lang?: string;
  langReason?: string;

  preparedAt: string;
  submittedAt: string | null;
  status: ApplicationStatus;

  cvFile: string;
  letterFile: string;
  jobDescriptionFile: string;
  proofFile: string | null;

  /** Outcome tracking — this is what turns the ledger into a measurement. */
  respondedAt: string | null;
  responseType: string | null;
  followUpDue: string | null;
  notes: string[];
}

export const APPLICATIONS_DIR = join(PROJECT_ROOT, "Applications");
export const LEDGER_FILE = join(PROJECT_ROOT, "APPLICATIONS.md");
const STAGING_DIR = join(PROJECT_ROOT, ".staging");

export function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function folderName(meta: {
  preparedAt: string;
  company: string;
  roleTitle: string;
}): string {
  const date = meta.preparedAt.slice(0, 10);
  return `${date}_${slugify(meta.company)}_${slugify(meta.roleTitle)}`;
}

/**
 * The CV's file name (without extension) inside an application folder.
 *
 * PDFs are printed by Chrome on Windows, which cannot write a path longer than
 * 260 characters. Seen from Windows the Applications folder already costs ~67
 * (`\\wsl.localhost\Ubuntu\…\Applications\`), and a folder plus a CV named
 * after company and role reached 290, and those applications never got a PDF.
 * The name is cut at a word boundary to keep the whole path
 * under the limit.
 */
export function cvFileBase(dirName: string, candidateName: string, maxRelativePath = 188): string {
  const full = `CV_${slugify(candidateName).replace(/-/g, "_")}_${dirName.replace(/^\d{4}-\d{2}-\d{2}_/, "")}`;
  const room = maxRelativePath - dirName.length - 1 - ".pdf".length;
  if (full.length <= room) return full;
  return full.slice(0, room).replace(/[-_][^-_]*$/, "");
}

export interface FileToWrite {
  name: string;
  content: string | Uint8Array;
}

/**
 * Write one application atomically: stage everything, then rename into place.
 * Returns the final directory path.
 */
export async function recordApplication(
  meta: ApplicationMeta,
  files: FileToWrite[],
  opts: { applicationsDir?: string; ledgerFile?: string } = {},
): Promise<string> {
  const appsDir = opts.applicationsDir ?? APPLICATIONS_DIR;
  const ledgerFile = opts.ledgerFile ?? LEDGER_FILE;
  const name = folderName(meta);
  const finalDir = join(appsDir, name);

  if (await exists(finalDir)) {
    throw new Error(`application folder already exists: ${finalDir}`);
  }

  const staging = join(STAGING_DIR, `${name}-${process.pid}-${Date.now()}`);
  await mkdir(staging, { recursive: true });

  try {
    for (const f of files) {
      await Bun.write(join(staging, f.name), f.content);
    }
    // meta.json written LAST inside staging: its presence means complete.
    await Bun.write(
      join(staging, "meta.json"),
      JSON.stringify(meta, null, 2) + "\n",
    );

    await mkdir(appsDir, { recursive: true });
    await rename(staging, finalDir); // atomic on the same filesystem
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }

  await rebuildLedgerView({ applicationsDir: appsDir, ledgerFile });
  return finalDir;
}

async function exists(p: string): Promise<boolean> {
  try {
    await readdir(p);
    return true;
  } catch {
    return false;
  }
}

/** Load every application record. meta.json files are the source of truth. */
export async function loadApplications(
  applicationsDir: string = APPLICATIONS_DIR,
): Promise<ApplicationMeta[]> {
  let entries: string[];
  try {
    entries = await readdir(applicationsDir);
  } catch {
    return [];
  }

  const out: ApplicationMeta[] = [];
  for (const entry of entries) {
    const metaPath = join(applicationsDir, entry, "meta.json");
    const file = Bun.file(metaPath);
    if (!(await file.exists())) continue;
    try {
      out.push((await file.json()) as ApplicationMeta);
    } catch {
      // A corrupt record must be visible, not silently dropped.
      console.warn(`[ledger] unreadable meta.json at ${metaPath} — skipped`);
    }
  }
  out.sort((a, b) => b.preparedAt.localeCompare(a.preparedAt));
  return out;
}

/** Dedupe check (ISC-37) — never apply to the same posting twice. */
export async function alreadyApplied(
  atsType: string,
  jobId: string,
  applicationsDir: string = APPLICATIONS_DIR,
): Promise<ApplicationMeta | null> {
  const id = `${atsType}:${jobId}`;
  const all = await loadApplications(applicationsDir);
  return all.find((a) => a.id === id) ?? null;
}

export async function updateStatus(
  id: string,
  patch: Partial<ApplicationMeta>,
  opts: { applicationsDir?: string; ledgerFile?: string } = {},
): Promise<ApplicationMeta> {
  const appsDir = opts.applicationsDir ?? APPLICATIONS_DIR;
  const entries = await readdir(appsDir);
  for (const entry of entries) {
    const metaPath = join(appsDir, entry, "meta.json");
    const file = Bun.file(metaPath);
    if (!(await file.exists())) continue;
    const meta = (await file.json()) as ApplicationMeta;
    if (meta.id !== id) continue;
    const updated = { ...meta, ...patch };
    await Bun.write(metaPath, JSON.stringify(updated, null, 2) + "\n");
    await rebuildLedgerView({
      applicationsDir: appsDir,
      ledgerFile: opts.ledgerFile ?? LEDGER_FILE,
    });
    return updated;
  }
  throw new Error(`no application found with id ${id}`);
}

/** Response-rate analysis by angle — the reason the ledger exists. */
export function analyseByAngle(apps: ApplicationMeta[]) {
  const responded = new Set<ApplicationStatus>([
    "screening", "interview", "offer",
  ]);
  const buckets = new Map<string, { sent: number; replies: number; rejections: number }>();
  for (const a of apps) {
    if (a.status === "prepared") continue;
    const key = a.angle ?? "(none)";
    const b = buckets.get(key) ?? { sent: 0, replies: 0, rejections: 0 };
    b.sent++;
    if (responded.has(a.status)) b.replies++;
    if (a.status === "rejected") b.rejections++;
    buckets.set(key, b);
  }
  return [...buckets.entries()]
    .map(([angle, b]) => ({
      angle,
      ...b,
      responseRate: b.sent > 0 ? b.replies / b.sent : 0,
    }))
    .sort((x, y) => y.responseRate - x.responseRate || y.sent - x.sent);
}

/** Regenerate APPLICATIONS.md from the meta.json records. */
export async function rebuildLedgerView(
  opts: { applicationsDir?: string; ledgerFile?: string } = {},
): Promise<string> {
  const appsDir = opts.applicationsDir ?? APPLICATIONS_DIR;
  const ledgerFile = opts.ledgerFile ?? LEDGER_FILE;
  const apps = await loadApplications(appsDir);

  const lines: string[] = [];
  lines.push("# Applications");
  lines.push("");
  lines.push(
    "> Generated from the `meta.json` in each folder under `Applications/`. " +
      "Those records are the source of truth — edit them, not this file, then " +
      "run `bun run src/ledger/ledger.ts` to regenerate.",
  );
  lines.push("");
  lines.push(`**Total:** ${apps.length}`);
  lines.push("");

  if (apps.length > 0) {
    const analysis = analyseByAngle(apps);
    if (analysis.length > 0) {
      lines.push("## Response rate by positioning angle");
      lines.push("");
      lines.push("| angle | sent | replies | rejections | response rate |");
      lines.push("|---|---:|---:|---:|---:|");
      for (const a of analysis) {
        lines.push(
          `| ${a.angle} | ${a.sent} | ${a.replies} | ${a.rejections} | ${(a.responseRate * 100).toFixed(0)}% |`,
        );
      }
      lines.push("");
    }
  }

  lines.push("## Log");
  lines.push("");
  lines.push("| submitted | company | role | angle | score | status | location | link |");
  lines.push("|---|---|---|---|---:|---|---|---|");
  for (const a of apps) {
    const when = (a.submittedAt ?? a.preparedAt).slice(0, 10);
    lines.push(
      `| ${when} | ${esc(a.company)} | ${esc(a.roleTitle)} | ${a.angle ?? "-"} | ` +
        `${a.score ?? "-"} | ${a.status} | ${esc(a.locationRaw)} | [posting](${a.url}) |`,
    );
  }
  lines.push("");

  const content = lines.join("\n");
  await Bun.write(ledgerFile, content);
  return content;
}

function esc(s: string): string {
  return (s ?? "").replace(/\|/g, "\\|");
}

// `bun run src/ledger/ledger.ts` — regenerate the view.
if (import.meta.main) {
  const content = await rebuildLedgerView();
  console.log(content.split("\n").slice(0, 25).join("\n"));
}
