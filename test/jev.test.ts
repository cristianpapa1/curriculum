/**
 * The Jev second opinion (src/pipeline/jev.ts).
 *
 * What must hold, whatever the model answers: only the posting leaves the
 * machine; the candidate's own facts are applied in code; an uncertain answer
 * keeps the posting and says why; an outage never stops a run; and a posting
 * already asked about is never billed again. No test reaches TypeSafe — every
 * client here is given a fake fetch.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorpus } from "../src/corpus/load.ts";
import { prepareApplications } from "../src/pipeline/prepare.ts";
import {
  createJevClient,
  judgeJevAnswers,
  reviewWithJev,
  type JevAnswer,
  type JevContext,
} from "../src/pipeline/jev.ts";

const corpus = await loadCorpus();

/** A posting nobody would object to; each test overrides the answer it is about. */
function answers(over: Record<string, JevAnswer> = {}): Record<string, JevAnswer> {
  return {
    seniority: { type: "score", score: 1.2, probabilities: { "1": 0.8, "2": 0.2 }, confidence: 0.8 },
    manages_people: { type: "noul", noul: 0.03 },
    discipline: { type: "choice", choice: "software_it_security", probabilities: { software_it_security: 0.97, other: 0.03 }, confidence: 0.96 },
    reserved_audience: { type: "noul", noul: 0.02 },
    citizenship_required: { type: "choice", choice: "none", probabilities: { none: 0.98, united_states: 0.02 }, confidence: 0.97 },
    security_clearance: { type: "noul", noul: 0.01 },
    location_excludes_home: { type: "noul", noul: 0.04 },
    ...over,
  };
}

// The persona holds Brazilian and Polish citizenship and lives in Brazil.
const remote: JevContext = { citizenships: ["Brazil", "Poland"], path: "remote-brazil-eligible", homeCountry: "Brazil" };

const job = {
  title: "Platform Engineer",
  locationRaw: "Remote, Brazil",
  remotePolicy: "remote" as const,
  descriptionText: "Platform engineering role. Terraform, Docker, Python, PostgreSQL, IAM.",
};

/** A fake TypeSafe endpoint: records each request body, answers with `reply`. */
function fakeApi(reply: (n: number) => Response) {
  const bodies: string[] = [];
  const fetch = async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    return reply(bodies.length);
  };
  return { fetch, bodies };
}

const ok = (a = answers()) =>
  new Response(JSON.stringify({ model: "jev-1.13.0", answers: a, usage: { input_tokens: 1200, output_tokens: 40 } }), { status: 200 });

describe("what leaves the machine", () => {
  test("only the posting is sent — the home country is the one candidate fact", async () => {
    const api = fakeApi(() => ok());
    const client = createJevClient({ apiKey: "test-key", cacheFile: null, fetch: api.fetch });
    await reviewWithJev(client, corpus, job, "remote-brazil-eligible");

    const body = api.bodies[0]!;
    expect(body).toContain("Platform Engineer");
    expect(body).toContain("Brazil");
    const id = corpus.profile.identity;
    for (const personal of [id.name, id.email, id.phone, "Poland"]) {
      expect(body).not.toContain(personal);
    }
  });
});

describe("answers about the posting become the candidate's decision in code", () => {
  test("a posting reserved for a group is set aside for the candidate to decide, not failed on fit", () => {
    const v = judgeJevAnswers(answers({ reserved_audience: { type: "noul", noul: 0.94 } }), remote);
    expect(v.ok).toBe(false);
    expect(v.check).toBe("reserved-audience");
    expect(v.reason).toMatch(/left for the candidate to decide/);
  });

  test("an uncertain reading keeps the posting and notes the doubt", () => {
    const v = judgeJevAnswers(answers({ reserved_audience: { type: "noul", noul: 0.62 } }), remote);
    expect(v.ok).toBe(true);
    expect(v.doubts).toEqual(["may be reserved for a group (62%)"]);
  });

  test("a citizenship the candidate holds is no barrier; one he lacks is", () => {
    const eu = judgeJevAnswers(answers({
      citizenship_required: { type: "choice", choice: "european_union", probabilities: { european_union: 0.95, none: 0.05 }, confidence: 0.9 },
    }), remote);
    expect(eu.ok).toBe(true);

    const us = judgeJevAnswers(answers({
      citizenship_required: { type: "choice", choice: "united_states", probabilities: { united_states: 0.95, none: 0.05 }, confidence: 0.9 },
    }), remote);
    expect(us.ok).toBe(false);
    expect(us.check).toBe("citizenship");
  });

  test("where the hire may live decides only the remote lane", () => {
    const excludes = answers({ location_excludes_home: { type: "noul", noul: 0.96 } });
    expect(judgeJevAnswers(excludes, remote).check).toBe("location");
    // A Europe relocation role excludes Brazil by definition — that is the lane.
    expect(judgeJevAnswers(excludes, { ...remote, path: "relocation-europe" }).ok).toBe(true);
  });

  test("staff level is set aside; senior is only noted", () => {
    const staff = judgeJevAnswers(answers({ seniority: { type: "score", score: 3.8, probabilities: { "4": 0.8, "3": 0.2 }, confidence: 0.7 } }), remote);
    expect(staff.check).toBe("level");
    const senior = judgeJevAnswers(answers({ seniority: { type: "score", score: 3.1, probabilities: { "3": 0.9, "4": 0.1 }, confidence: 0.8 } }), remote);
    expect(senior.ok).toBe(true);
    expect(senior.doubts[0]).toMatch(/reads as senior/);
  });

  test("a senior reading is noted only when the title hides it", () => {
    // Audit, 2026-10-13: 11 of 13 notes said "reads as senior" about titles
    // that already said Sênior — the note is for "DevOps Engineer" asking for senior.
    const senior = answers({ seniority: { type: "score", score: 3.0, probabilities: { "3": 1 }, confidence: 1 } });
    expect(judgeJevAnswers(senior, { ...remote, title: "Analista de SRE Sênior" }).doubts).toEqual([]);
    expect(judgeJevAnswers(senior, { ...remote, title: "DevOps Engineer" }).doubts[0]).toMatch(/reads as senior/);
  });

  test("a business function inside IT is set aside as one", () => {
    const v = judgeJevAnswers(answers({
      discipline: { type: "choice", choice: "business_function", probabilities: { business_function: 0.91, software_it_security: 0.09 }, confidence: 0.85 },
    }), remote);
    expect(v.check).toBe("discipline");
  });
});

describe("the client", () => {
  test("a posting already asked about is not asked — or billed — again", async () => {
    const cacheFile = join(mkdtempSync(join(tmpdir(), "curriculum-jev-")), "answers.jsonl");
    const api = fakeApi(() => ok());
    const first = createJevClient({ apiKey: "k", cacheFile, fetch: api.fetch });
    await reviewWithJev(first, corpus, job, "remote-brazil-eligible");
    await reviewWithJev(first, corpus, job, "remote-brazil-eligible");
    expect(api.bodies.length).toBe(1);
    expect(first.usage).toEqual({ calls: 1, cached: 1, inputTokens: 1200 });

    // A later run reads the same file.
    const second = createJevClient({ apiKey: "k", cacheFile, fetch: api.fetch });
    await reviewWithJev(second, corpus, job, "remote-brazil-eligible");
    expect(api.bodies.length).toBe(1);
  });

  test("a rate limit is waited out, for as long as retry-after says", async () => {
    const waits: number[] = [];
    const api = fakeApi((n) => (n === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "2" } }) : ok()));
    const client = createJevClient({ apiKey: "k", cacheFile: null, fetch: api.fetch, sleep: async (ms) => void waits.push(ms) });
    await reviewWithJev(client, corpus, job, "remote-brazil-eligible");
    expect(waits).toEqual([2000]);
    expect(client.usage.calls).toBe(1);
  });

  test("a rejected key names the variable to fix and never echoes the key", async () => {
    const api = fakeApi(() => new Response('{"detail":"invalid key"}', { status: 401 }));
    const client = createJevClient({ apiKey: "sk-secret-123", cacheFile: null, fetch: api.fetch });
    const err = await reviewWithJev(client, corpus, job, "remote-brazil-eligible").catch((e: Error) => e);
    expect((err as Error).message).toMatch(/TYPESAFE_API_KEY/);
    expect((err as Error).message).not.toContain("sk-secret-123");
  });
});

describe("in the prepare pipeline", () => {
  const posting = (title: string, url: string) => `company: Northstar Labs
title: ${title}
url: ${url}
location: Remote, Brazil
remote: remote
description: |
  Platform engineering role. Terraform, Docker, Python, PostgreSQL, IAM.
`;

  function run(api: ReturnType<typeof fakeApi>, url: string) {
    const dir = mkdtempSync(join(tmpdir(), "curriculum-jev-prepare-"));
    const file = join(dir, "posting.yaml");
    writeFileSync(file, posting("Platform Engineer", url));
    const jev = createJevClient({ apiKey: "k", cacheFile: null, fetch: api.fetch, sleep: async () => {} });
    return prepareApplications(corpus, [{ atsType: "manual", token: file }], {
      limit: 1, minScore: 0, pdf: false, jev,
      applicationsDir: join(dir, "apps"), ledgerFile: join(dir, "APPLICATIONS.md"),
    });
  }

  test("a posting Jev sets aside is skipped with Jev's reason", async () => {
    const result = await run(fakeApi(() => ok(answers({ reserved_audience: { type: "noul", noul: 0.95 } }))), "https://example.com/jev-1");
    expect(result.prepared.length).toBe(0);
    expect(result.skipped[0]!.reason).toMatch(/^jev\/reserved-audience:/);
    expect(result.jev?.calls).toBe(1);
  });

  test("a doubt is carried into meta.json for whoever approves it", async () => {
    const result = await run(fakeApi(() => ok(answers({ manages_people: { type: "noul", noul: 0.6 } }))), "https://example.com/jev-2");
    expect(result.prepared.length).toBe(1);
    expect(result.prepared[0]!.meta.notes).toEqual(["jev: may manage people (60%)"]);
  });

  describe("junior focus (--focus-only)", () => {
    // The persona targets junior in "other", and "Platform Engineer" names no
    // level — so the title check alone excludes it, whatever the posting asks.
    function focus(api: ReturnType<typeof fakeApi> | null, url: string) {
      const dir = mkdtempSync(join(tmpdir(), "curriculum-jev-focus-"));
      const file = join(dir, "posting.yaml");
      writeFileSync(file, posting("Platform Engineer", url));
      const jev = api && createJevClient({ apiKey: "k", cacheFile: null, fetch: api.fetch, sleep: async () => {} });
      return prepareApplications(corpus, [{ atsType: "manual", token: file }], {
        limit: 1, minScore: 0, pdf: false, focusOnly: true, jev,
        applicationsDir: join(dir, "apps"), ledgerFile: join(dir, "APPLICATIONS.md"),
      });
    }
    const atLevel = (score: number) =>
      ok(answers({ seniority: { type: "score", score, probabilities: { [String(Math.round(score))]: 1 }, confidence: 1 } }));

    test("a title naming no level is let in when Jev reads the posting as junior", async () => {
      const api = fakeApi(() => atLevel(1.1));
      const result = await focus(api, "https://example.com/jev-focus-1");
      expect(result.prepared.length).toBe(1);
      expect(result.prepared[0]!.meta.notes[0]).toMatch(/admitted as junior \(1\.1/);
      // The review that follows asks the same request: one call, not two.
      expect(api.bodies.length).toBe(1);
    });

    test("a mid-level reading stays out", async () => {
      const result = await focus(fakeApi(() => atLevel(2.2)), "https://example.com/jev-focus-2");
      expect(result.prepared.length).toBe(0);
      expect(result.skipped[0]!.reason).toMatch(/^level: /);
    });

    test("without Jev the title check decides, as before", async () => {
      const result = await focus(null, "https://example.com/jev-focus-3");
      expect(result.prepared.length).toBe(0);
    });
  });

  test("an outage fails open: the posting is prepared and the run says the check was off", async () => {
    const result = await run(fakeApi(() => new Response("overloaded", { status: 529 })), "https://example.com/jev-3");
    expect(result.prepared.length).toBe(1);
    expect(result.errors.some((e) => /^jev: .*second opinion off/.test(e))).toBe(true);
  });
});
