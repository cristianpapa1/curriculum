/**
 * Email security-code listener.
 *
 * Greenhouse sends an 8-character code to the applicant's inbox on every
 * submission ("Security code for your application to <company>") and refuses the
 * application until it is typed in. Without reading that email, no Greenhouse
 * application can complete.
 *
 * Access is via IMAP with a Google App Password (never the account password).
 * That grants read access to the whole mailbox, so this module constrains
 * itself in code:
 *   - it only SEARCHes for messages from greenhouse-mail.io with a "security
 *     code" subject, received after the submission started;
 *   - it never logs, stores or returns a message body — only the extracted code;
 *   - it opens the mailbox read-only and marks nothing as read.
 *
 * Revoke the App Password at myaccount.google.com/apppasswords to cut access.
 */

import { ImapFlow } from "imapflow";
import { join } from "node:path";
import { PROJECT_ROOT } from "../corpus/load.ts";
import { loadPolicy } from "../corpus/policy.ts";

export interface MailCredentials {
  user: string;
  appPassword: string;
  host: string;
  port: number;
}

/** Senders whose codes we accept. Anything else is ignored. */
const CODE_SENDERS = ["greenhouse-mail.io", "greenhouse.io"];

async function readEnv(): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...(process.env as Record<string, string>) };
  const file = Bun.file(join(PROJECT_ROOT, ".env"));
  if (await file.exists()) {
    for (const raw of (await file.text()).split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const i = line.indexOf("=");
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

/** Null when the listener is not configured — callers fall back to a human. */
export async function loadMailCredentials(): Promise<MailCredentials | null> {
  const env = await readEnv();
  const user = env.MAIL_IMAP_USER || env.APPLICANT_EMAIL;
  // Google shows app passwords with spaces ("abcd efgh ijkl mnop"); strip them.
  const appPassword = (env.MAIL_APP_PASSWORD ?? "").replace(/\s+/g, "");
  if (!user || !appPassword) return null;
  return {
    user,
    appPassword,
    host: env.MAIL_IMAP_HOST || "imap.gmail.com",
    port: Number(env.MAIL_IMAP_PORT || 993),
  };
}

/**
 * Pull the security code out of an email's text.
 *
 * Anchored on the sentence around the code rather than "any 8 capitals", so a
 * word like "GREENHOUSE" or "RECRUITING" in the template is never mistaken for it.
 */
export function extractSecurityCode(text: string): string | null {
  const flat = text
    .replace(/<(style|head|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/=\r?\n/g, "")
    .replace(/\s+/g, " ");
  // Two things found on a live code email: the gap between the anchor and
  // the code contains capitals (the company name), and the raw code is
  // mixed-case and CASE-SENSITIVE — the template only DISPLAYS it upper-case
  // through CSS, and typing that upper-case form was refused as "Incorrect
  // security code". Returned exactly as written. A token that reads as
  // an ordinary word ("Security", "applying") is skipped.
  const re = /(?:security code field|security code|verification code)[\s\S]{0,300}?\b([A-Za-z0-9]{8})\b/gi;
  const isWord = (t: string) => /^[A-Z]?[a-z]{7}$/.test(t);
  let from = 0;
  while (from < flat.length) {
    re.lastIndex = from;
    const m = re.exec(flat);
    if (!m) break;
    const token = m[1]!;
    if (!isWord(token) && /[A-Za-z0-9]{8}/.test(token) && (/\d/.test(token) || /[a-z][A-Z]|[A-Z]{2}/.test(token))) {
      return token;
    }
    from = m.index + m[0].length - token.length + 1;
  }

  return null;
}

export interface WaitOptions {
  /** Only accept emails received at or after this moment. */
  since: Date;
  /** Company name expected in the subject, when known. */
  company?: string;
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Wait for a fresh security-code email and return the code.
 * Throws on timeout; returns null only if the listener is unconfigured.
 */
/**
 * Other names a company mails under, keyed by its squashed ledger name — a
 * company renamed since the posting was written never matches the subject line.
 * Configured by the candidate in preferences.yaml:
 *
 *   mail:
 *     company_aliases: { oldname: ["New Name"] }
 */
const companyAliases = (): Record<string, string[]> => loadPolicy().mailCompanyAliases;

export async function waitForSecurityCode(opts: WaitOptions): Promise<string | null> {
  const creds = await loadMailCredentials();
  if (!creds) return null;

  const timeout = opts.timeoutMs ?? 180_000;
  const poll = opts.pollMs ?? 6_000;
  const deadline = Date.now() + timeout;
  // IMAP SINCE has day granularity; the exact cutoff is re-checked per message.
  const sinceDay = new Date(opts.since.getTime() - 24 * 3600 * 1000);

  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: true,
    auth: { user: creds.user, pass: creds.appPassword },
    logger: false,
  });

  await client.connect();
  try {
    while (Date.now() < deadline) {
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const uids = (await client.search(
          { since: sinceDay, subject: "security code", from: "greenhouse" },
          { uid: true },
        )) || [];
        // Newest first.
        // Fresh code emails from Greenhouse, newest first. The subject names the
        // company — compared without spaces and punctuation, since the ledger says
        // "Abinbev" and the email "AB InBev | Growth Group" — under any of its
        // names, including any alias the candidate configured.
        const squash = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");
        const names = opts.company ? [opts.company, ...(companyAliases()[squash(opts.company)] ?? [])].map(squash) : [];
        const fresh: { uid: number; msg: any; named: boolean }[] = [];
        for (const uid of [...uids].reverse()) {
          const msg = await client.fetchOne(String(uid), { envelope: true, bodyStructure: true, internalDate: true }, { uid: true });
          if (!msg) continue;
          const received = msg.internalDate ? new Date(msg.internalDate) : null;
          if (!received || received.getTime() < opts.since.getTime() - 60_000) continue;
          const from = msg.envelope?.from?.[0]?.address ?? "";
          if (!CODE_SENDERS.some((d) => from.toLowerCase().endsWith(d))) continue;
          const subject = squash(msg.envelope?.subject ?? "");
          fresh.push({ uid: Number(uid), msg, named: names.length === 0 || names.some((n) => subject.includes(n)) });
        }
        // A company renamed since the ledger was written would never match. When
        // no fresh email names it but exactly ONE code arrived after the click,
        // that one is this application's: submissions run one at a time.
        const named = fresh.filter((m) => m.named);
        const chosen = named.length > 0 ? named : fresh.length === 1 ? fresh : [];
        for (const { uid, msg } of chosen) {

          // The body is quoted-printable/base64 HTML; the raw MIME source never
          // matched (found live). Decode each text part and read that.
          const parts: string[] = [];
          const walk = (n: any) => {
            if (!n) return;
            if (n.childNodes) n.childNodes.forEach(walk);
            else if (String(n.type).startsWith("text/")) parts.push(n.part ?? "1");
          };
          walk(msg.bodyStructure);
          for (const part of parts) {
            const { content } = await client.download(String(uid), part, { uid: true });
            const chunks: Buffer[] = [];
            for await (const chunk of content) chunks.push(chunk as Buffer);
            const code = extractSecurityCode(Buffer.concat(chunks).toString("utf8"));
            if (code) return code;
          }
        }
      } finally {
        lock.release();
      }
      await new Promise((r) => setTimeout(r, poll));
    }
  } finally {
    await client.logout().catch(() => {});
  }
  throw new Error(`no security-code email from Greenhouse within ${Math.round(timeout / 1000)}s`);
}

// `bun run src/pipeline/mailcodes.ts` — verify the connection without reading mail.
if (import.meta.main) {
  const creds = await loadMailCredentials();
  if (!creds) {
    console.log("listener NOT configured — set MAIL_APP_PASSWORD in .env (see .env.example)");
    process.exit(1);
  }
  const client = new ImapFlow({ host: creds.host, port: creds.port, secure: true, auth: { user: creds.user, pass: creds.appPassword }, logger: false });
  await client.connect();
  const status = await client.status("INBOX", { messages: true });
  console.log(`connected as ${creds.user} — INBOX has ${status.messages} messages (none read)`);
  const since = new Date(Date.now() - 6 * 3600 * 1000);
  const lock = await client.getMailboxLock("INBOX", { readOnly: true });
  try {
    const uids = (await client.search({ since, subject: "security code", from: "greenhouse" }, { uid: true })) || [];
    console.log(`Greenhouse security-code emails in the last 6h: ${uids.length}`);
  } finally {
    lock.release();
    await client.logout();
  }
}
