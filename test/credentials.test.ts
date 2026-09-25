/**
 * Credential-handling tests.
 *
 * Credentials are used when a portal requires an account. These tests make
 * sure "used" never becomes "leaked" — into a rendered CV, a cover letter, an
 * application folder, the ledger or a log line. They load the fictional
 * `test/fixtures/applicant.env` (see test/setup.ts); the last two also guard a
 * real `.env`, when one exists, against copies in the local corpus and notes.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadCorpus } from "../src/corpus/load.ts";
import { renderCV } from "../src/render/cv.ts";
import { renderLetter } from "../src/render/letter.ts";
import {
  loadIdentity,
  loadCredentials,
  describe as describeCreds,
  redact,
  requiresAccount,
  accountsNeededFor,
} from "../src/pipeline/credentials.ts";
import { PROJECT_ROOT } from "../src/corpus/load.ts";
import { ANGLES } from "../src/position/angles.ts";

const corpus = await loadCorpus();

describe("credential loading", () => {
  test("identity loads without touching the password", async () => {
    const id = await loadIdentity();
    expect(id.email).toContain("@");
    expect(id.fullName.length).toBeGreaterThan(0);
    expect(Object.keys(id)).not.toContain("password");
  });

  test("credentials load with a password present", async () => {
    const c = await loadCredentials();
    expect(c.password.length).toBeGreaterThan(0);
  });
});

describe("the password must never surface", () => {
  test("describe() never includes the password", async () => {
    const c = await loadCredentials();
    const printed = describeCreds(c);
    expect(printed).not.toContain(c.password);
    expect(printed).toContain("redacted");
  });

  test("redact() removes the password from arbitrary text", async () => {
    const c = await loadCredentials();
    const dirty = `POST /login body=${c.password}&user=x`;
    const clean = await redact(dirty);
    expect(clean).not.toContain(c.password);
    expect(clean).toContain("«redacted»");
  });

  test("no rendered CV contains the password, for any angle", async () => {
    const c = await loadCredentials();
    for (const angle of ANGLES.map((a) => a.id)) {
      const cv = renderCV(corpus, angle);
      expect(cv.markdown).not.toContain(c.password);
      expect(cv.html).not.toContain(c.password);
    }
  });

  test("no rendered cover letter contains the password", async () => {
    const c = await loadCredentials();
    for (const angle of ANGLES.map((a) => a.id)) {
      const letter = renderLetter(corpus, angle, { company: "Acme", roleTitle: "Engineer" });
      expect(letter.markdown).not.toContain(c.password);
      expect(letter.html).not.toContain(c.password);
    }
  });

  test("a real .env password is not copied into the local corpus", async () => {
    const secret = await localPassword();
    if (!secret) return;
    for (const file of ["claims.yaml", "profile.yaml", "i18n.yaml", "preferences.yaml", "form-answers.json"]) {
      const f = Bun.file(join(PROJECT_ROOT, "Corpus", file));
      if (!(await f.exists())) continue;
      expect(await f.text()).not.toContain(secret);
    }
  });

  test("a real .env password is not copied into local notes", async () => {
    const secret = await localPassword();
    if (!secret) return;
    for (const file of ["ISA.md", "CLAUDE.local.md", "MANUAL-INDEX.md"]) {
      const f = Bun.file(join(PROJECT_ROOT, file));
      if (await f.exists()) expect(await f.text()).not.toContain(secret);
    }
  });
});

/** The password in this working copy's own .env, if there is one — never printed. */
async function localPassword(): Promise<string> {
  const env = Bun.file(join(PROJECT_ROOT, ".env"));
  if (!(await env.exists())) return "";
  const line = (await env.text()).split("\n").find((l) => l.trim().startsWith("APPLICANT_PASSWORD="));
  const value = line?.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") ?? "";
  return value.length >= 4 ? value : "";
}

describe(".env is protected", () => {
  test(".gitignore excludes .env and keeps .env.example", async () => {
    const gitignore = await Bun.file(join(PROJECT_ROOT, ".gitignore")).text();
    expect(gitignore).toMatch(/^\.env$/m);
    expect(gitignore).toMatch(/^!\.env\.example$/m);
  });

  test(".gitignore excludes personal application artifacts", async () => {
    const gitignore = await Bun.file(join(PROJECT_ROOT, ".gitignore")).text();
    expect(gitignore).toMatch(/^Applications\/$/m);
    expect(gitignore).toMatch(/^Sources\/$/m);
  });

  test(".env.example carries no value for the password", async () => {
    const example = await Bun.file(join(PROJECT_ROOT, ".env.example")).text();
    expect(example).toMatch(/^APPLICANT_PASSWORD=\s*$/m);
  });
});

describe("which platforms actually need an account", () => {
  test("no supported ATS requires one", () => {
    for (const ats of ["greenhouse", "lever", "ashby", "workable", "smartrecruiters"]) {
      expect(requiresAccount(ats)).toBe(false);
    }
  });

  test("Workday, iCIMS, Taleo and LinkedIn do", () => {
    for (const ats of ["workday", "icims", "taleo", "linkedin"]) {
      expect(requiresAccount(ats)).toBe(true);
    }
  });

  test("accountsNeededFor reports only the platforms that need sign-in", () => {
    expect(accountsNeededFor(["greenhouse", "ashby", "workday", "workday"])).toEqual(["workday"]);
    expect(accountsNeededFor(["greenhouse", "lever"])).toEqual([]);
  });
});
