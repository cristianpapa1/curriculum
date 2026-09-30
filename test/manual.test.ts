/**
 * Postings described by hand.
 *
 * A posting that lives behind a login (a talent marketplace) or on a custom
 * careers app still deserves a tailored CV and a ledger entry. The manual
 * adapter ingests it from a file; everything downstream must treat it exactly
 * like a posting a board returned — and nothing may ever submit it.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manualAdapter } from "../src/ats/manual.ts";
import { adapters } from "../src/ats/index.ts";
import { MANUAL_BOARDS } from "../src/pipeline/submit.ts";

const dir = mkdtempSync(join(tmpdir(), "curriculum-manual-"));
const write = (name: string, body: string) => {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
};

const FULL = `company: Northstar Labs
title: Integrations Engineer
url: https://example.com/jobs/integrations
location: Remote, LATAM
remote: remote
employmentType: Full-time
salary: USD 70,000 - 90,000
description: |
  Build and maintain third-party integrations: webhooks, queues, REST APIs.
  Requirements: Node.js, TypeScript, PostgreSQL.
`;

describe("ingesting a posting from a file", () => {
  test("every field a board would supply is carried through", async () => {
    const [job] = await manualAdapter.fetchJobs(write("full.yaml", FULL));
    expect(job!.atsType).toBe("manual");
    expect(job!.companyToken).toBe("northstar-labs");
    expect(job!.title).toBe("Integrations Engineer");
    expect(job!.url).toBe("https://example.com/jobs/integrations");
    expect(job!.locationRaw).toBe("Remote, LATAM");
    expect(job!.remotePolicy).toBe("remote");
    expect(job!.salaryRaw).toBe("USD 70,000 - 90,000");
    expect(job!.descriptionText).toContain("webhooks, queues, REST APIs");
    expect(job!.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("the id is derived from the url, so re-ingesting updates one application", async () => {
    const first = await manualAdapter.fetchJobs(write("a.yaml", FULL));
    const second = await manualAdapter.fetchJobs(write("b.yaml", FULL));
    expect(first[0]!.id).toBe(second[0]!.id);
    expect(first[0]!.id.length).toBeGreaterThan(0);
  });

  test("remote policy is inferred when the file does not declare one", async () => {
    const path = write(
      "inferred.yaml",
      `company: Acme
title: Platform Engineer
url: https://example.com/jobs/platform
location: Remote - Brazil
description: Fully remote role, open to candidates anywhere in Brazil.
`,
    );
    const [job] = await manualAdapter.fetchJobs(path);
    expect(job!.remotePolicy).toBe("remote");
  });

  test("a list of postings in one file is read as many", async () => {
    const path = write(
      "list.yaml",
      `- company: Acme
  title: SRE
  url: https://example.com/a
  location: Remote
- company: Acme
  title: Security Engineer
  url: https://example.com/b
  location: Remote
`,
    );
    expect((await manualAdapter.fetchJobs(path)).map((j) => j.title)).toEqual(["SRE", "Security Engineer"]);
  });

  test("JSON is accepted as well as YAML", async () => {
    const path = write(
      "one.json",
      JSON.stringify({ company: "Acme", title: "Backend Engineer", url: "https://example.com/c", location: "Remote" }),
    );
    expect((await manualAdapter.fetchJobs(path))[0]!.title).toBe("Backend Engineer");
  });
});

describe("a file that cannot be trusted is refused, not guessed at", () => {
  test("a missing required field names the field", async () => {
    const path = write("nourl.yaml", "company: Acme\ntitle: Engineer\n");
    await expect(manualAdapter.fetchJobs(path)).rejects.toThrow(/url/);
  });

  test("an unknown remote policy is refused", async () => {
    const path = write(
      "badremote.yaml",
      "company: Acme\ntitle: Engineer\nurl: https://example.com/d\nremote: sometimes\n",
    );
    await expect(manualAdapter.fetchJobs(path)).rejects.toThrow(/remote must be one of/);
  });

  test("a missing file is refused", async () => {
    await expect(manualAdapter.fetchJobs(join(dir, "nope.yaml"))).rejects.toThrow(/not found/);
  });

  test("probe answers false instead of throwing", async () => {
    expect(await manualAdapter.probe(join(dir, "nope.yaml"))).toBe(false);
    expect(await manualAdapter.probe(write("probe.yaml", FULL))).toBe(true);
  });
});

describe("a hand-described posting is never submitted automatically", () => {
  test("it is registered as an ingest adapter", () => {
    expect(adapters.manual).toBe(manualAdapter);
  });

  test("REGRESSION: 'manual' is a manual board — there is no form to fill", () => {
    expect(MANUAL_BOARDS.has("manual")).toBe(true);
  });
});
