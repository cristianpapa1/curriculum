#!/usr/bin/env bun
/**
 * Environment check — run before onboarding, and whenever something fails.
 *
 * Every check here is one that failed for real while this pipeline was built:
 * PDFs that were never produced (no Chrome visible from WSL, paths over 260
 * characters), a browser that would not launch (a profile locked by another run),
 * an `.env` readable by other users, a mailbox password that did not work. Each
 * prints what is wrong and the command that fixes it.
 *
 *   bun run doctor
 */

import { existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { PROJECT_ROOT, CORPUS_DIR, loadCorpus } from "../src/corpus/load.ts";
import { detectPdfEngine } from "../src/render/pdf.ts";
import { loadMailCredentials } from "../src/pipeline/mailcodes.ts";
import { onboardingRecord } from "../src/pipeline/onboarding.ts";

type Status = "ok" | "warn" | "fail";
const results: { status: Status; name: string; detail: string; fix?: string }[] = [];
const check = (status: Status, name: string, detail: string, fix?: string) => results.push({ status, name, detail, fix });

// ── Runtime ────────────────────────────────────────────────────────────────
const [major, minor] = Bun.version.split(".").map(Number) as [number, number];
check(major > 1 || (major === 1 && minor >= 2) ? "ok" : "fail", "Bun", `v${Bun.version}`, "curl -fsSL https://bun.sh/install | bash");

check(existsSync(join(PROJECT_ROOT, "node_modules", "playwright")) ? "ok" : "fail",
  "Dependencies", existsSync(join(PROJECT_ROOT, "node_modules")) ? "installed" : "not installed", "bun install");

// ── Browser for filling forms (Firefox via Playwright) ────────────────────
const pwCache = join(homedir(), ".cache", "ms-playwright");
const firefox = existsSync(pwCache) && readdirSync(pwCache).some((d) => d.startsWith("firefox"));
check(firefox ? "ok" : "fail", "Form browser", firefox ? "Playwright Firefox installed" : "Playwright Firefox missing",
  "bunx playwright install firefox");

// ── PDF engine (Chrome or Chromium; on WSL the Windows Chrome works) ───────
const pdf = await detectPdfEngine();
check(pdf ? "ok" : "fail", "PDF engine", pdf ? `${pdf.kind}: ${pdf.binary}` : "no Chrome, Chromium or Edge found",
  "install google-chrome or chromium (on WSL, Chrome installed on Windows is found automatically)");
if (pdf?.kind === "windows-chrome") {
  // Chrome on Windows cannot write paths over 260 characters.
  const depth = `\\\\wsl.localhost\\Ubuntu${PROJECT_ROOT}\\Applications\\`.length;
  check(depth < 90 ? "ok" : "warn", "Path length", `${depth} characters before each application folder`,
    "keep the project in a short path — Windows Chrome refuses PDF paths over 260 characters");
}

// ── Secrets ────────────────────────────────────────────────────────────────
const envPath = join(PROJECT_ROOT, ".env");
if (!existsSync(envPath)) {
  check("fail", ".env", "missing — onboarding writes it", "bun run onboard");
} else {
  const mode = statSync(envPath).mode & 0o777;
  check(mode & 0o077 ? "fail" : "ok", ".env permissions", `mode ${mode.toString(8)}`, "chmod 600 .env");
  const gitignore = await Bun.file(join(PROJECT_ROOT, ".gitignore")).text().catch(() => "");
  check(/^\.env$/m.test(gitignore) ? "ok" : "fail", ".env ignored by git", /^\.env$/m.test(gitignore) ? "yes" : "NOT in .gitignore",
    "echo .env >> .gitignore");
}

// ── Mailbox (optional: only for emailed security codes) ────────────────────
const mail = await loadMailCredentials().catch(() => null);
if (!mail) {
  check("warn", "Mailbox", "not configured — forms that email a security code will stop for you",
    "optional: set MAIL_IMAP_USER and MAIL_APP_PASSWORD in .env (an app password, never your real one)");
} else {
  try {
    const { ImapFlow } = await import("imapflow");
    const client = new ImapFlow({ host: mail.host, port: mail.port, secure: true, auth: { user: mail.user, pass: mail.appPassword }, logger: false });
    await client.connect();
    await client.logout();
    check("ok", "Mailbox", `IMAP login works for ${mail.user.replace(/(.).+@/, "$1…@")} (no message was read)`);
  } catch (err) {
    check("fail", "Mailbox", `IMAP login failed: ${(err as Error).message.slice(0, 80)}`,
      "create an app password (Google: myaccount.google.com/apppasswords) and set MAIL_APP_PASSWORD");
  }
}

// ── Corpus and onboarding ─────────────────────────────────────────────────
try {
  const corpus = await loadCorpus();
  const fixture = CORPUS_DIR.includes(join("fixtures", "corpus"));
  check(fixture ? "warn" : "ok", "Corpus", `${corpus.profile.identity.name} — ${corpus.claims.length} claims (${CORPUS_DIR})`,
    fixture ? "this is the invented test persona: run bun run onboard to write your own" : undefined);
} catch (err) {
  check("fail", "Corpus", (err as Error).message.slice(0, 120), "bun run onboard");
}
const record = await onboardingRecord();
check(record ? "ok" : "fail", "Onboarding", record ? `completed ${record.completedAt.slice(0, 10)}, autonomy: ${record.autonomy}` : "not completed — live submission is locked",
  "bun run onboard");

// ── Report ─────────────────────────────────────────────────────────────────
const icon: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗" };
for (const r of results) {
  console.log(`${icon[r.status]} ${r.name.padEnd(22)} ${r.detail}`);
  if (r.status !== "ok" && r.fix) console.log(`  ${" ".repeat(22)} → ${r.fix}`);
}
const failed = results.filter((r) => r.status === "fail").length;
console.log(failed ? `\n${failed} problem(s) to fix before applying.` : "\nReady.");
process.exit(failed ? 1 : 0);
