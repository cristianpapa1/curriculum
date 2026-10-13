/**
 * A second opinion on the fit gate, from a model that reads the posting.
 *
 * fit.ts makes a recruiter's ten-second checks with regular expressions, and
 * nearly every one was written after a posting slipped past the one before:
 * "Analista Financeiro Pleno TI" came in on the word "TI", "Data Center
 * Controls Network Engineer" scored 88, "Engineering Lead, Payments Platform"
 * passed every level pattern. Each fix catches the wording that taught it and
 * not the next one. TypeSafe's Jev model answers the same questions — level,
 * discipline, reserved audience, citizenship, where the hire may work — as
 * typed judgments with probabilities, so a new wording needs no new pattern.
 *
 * Three rules shape it:
 *   - Only the POSTING is sent. No name, CV or corpus fact leaves the machine.
 *     The candidate's side (citizenships, level policy) is applied here, in
 *     code, to answers about the posting. The one exception is the home
 *     country, without which "does this exclude where he lives?" cannot be
 *     asked.
 *   - It SETS ASIDE, and lifts nothing a fit gate decided. It runs on
 *     postings about to be tailored, so it is paid for only where it changes
 *     what gets prepared. The one thing it may lift is the junior-focus TITLE
 *     check (--focus-only): most junior postings never say "junior" in the
 *     title, and Jev placing the text at junior lets one in (prepare.ts).
 *   - It FAILS OPEN. The regex gates have already run, so an outage prepares
 *     what would have been prepared before this module existed, and the run's
 *     errors say so.
 *
 * Answers are cached by (model, questions, posting) in logs/jev-answers.jsonl:
 * a re-run, an audit, or the same posting on a second board costs nothing.
 * Rewording a question changes the key, so the new wording is asked afresh.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NormalizedJob } from "../ats/types.ts";
import type { Corpus } from "../corpus/types.ts";
import { PROJECT_ROOT } from "../corpus/load.ts";
import { EU_CITIZENSHIP, loadPolicy } from "../corpus/policy.ts";
import { envSetting } from "./credentials.ts";
import type { EligibilityPath } from "./eligibility.ts";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/**
 * Pinned rather than "jev-latest": the thresholds below were set against this
 * version, and an alias that moves would shift them without a code change.
 */
export const JEV_MODEL = "jev-1.13.0";

/** USD per input token for JEV_MODEL ($0.042 per million). Output tokens are free. */
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export const JEV_CACHE_FILE = join(PROJECT_ROOT, "logs", "jev-answers.jsonl");

/**
 * The state limit is 32k tokens. Level, location and citizenship lines can sit
 * anywhere — EEO and clearance clauses are usually at the very end — so this
 * keeps far more than the first screen, and only trims the rare giant posting.
 */
const MAX_DESCRIPTION_CHARS = 24_000;

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;

// ── Questions ──────────────────────────────────────────────────────────────

type Text = string | Record<string, unknown> | unknown[];

export type JevQuestion =
  | { type: "noul"; instructions: Text; criteria?: { true?: Text; false?: Text } }
  | { type: "choice"; instructions: Text; criteria: Record<string, Text | null> }
  | { type: "score"; instructions: Text; criteria: Text[] };

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };

/** Disciplines the fit gate excludes, with the words a skip reason uses for them. */
const OUT_OF_DISCIPLINE: Record<string, string> = {
  physical_engineering: "physical engineering (electrical, mechanical, hardware …)",
  facility_ot: "facility or operational-technology engineering",
  business_function: "a business function, not IT or engineering",
};

/**
 * One question per judgment, about the posting alone. Several are asked even
 * when the eligibility path makes them moot (location on a Europe relocation
 * role): they cost a few tokens, run in parallel, and keep the cache key the
 * same whichever lane the posting arrived in.
 */
const POSTING_QUESTIONS: Record<string, JevQuestion> = {
  seniority: {
    type: "score",
    instructions: "What level of experience does `posting` expect of the person hired, judged from its title, responsibilities and stated requirements?",
    criteria: [
      "Internship, apprenticeship, trainee or student programme",
      "Entry level or junior: asks for little or no professional experience, about 0–2 years",
      "Mid level: asks for a few years of experience, about 2–5, and independent work",
      "Senior: asks for about 5–8 years, or describes the hire as senior or highly experienced",
      // "Architect" was in this level once and pulled every architect title to
      // the top whatever its years; the years and the scope decide, not the title.
      "Staff or principal: asks for about 8 or more years, or for setting technical direction across several teams or the whole company",
    ],
  },
  manages_people: {
    type: "noul",
    instructions: "Does the role in `posting` manage people?",
    criteria: {
      true: "The hire has direct reports, runs a team as its manager, or is responsible for hiring and performance reviews",
      false: "An individual contributor, including one who mentors others or coordinates work without managing anyone",
    },
  },
  discipline: {
    type: "choice",
    instructions: "What kind of work is the day-to-day job in `posting`?",
    criteria: {
      // Customer-facing engineering is named outright: without it, solutions-
      // engineer postings read as sales at up to 96%, though the work is
      // designing and demonstrating integrations.
      software_it_security: "Technical work in software, cloud, DevOps or SRE, IT infrastructure and operations, networking, IT support, data engineering, or information security and identity, including customer-facing technical roles such as solutions, sales or support engineering, where the hire designs, integrates, demonstrates or troubleshoots the technology",
      physical_engineering: "Electrical, mechanical, civil, chemical, hardware, firmware, embedded, RF or manufacturing engineering: work on physical products or systems rather than software or IT",
      facility_ot: "Data-centre facilities, building management or automation, industrial control systems, SCADA, PLC or other operational technology",
      business_function: "Sales, account management, business development, customer success management, finance, accounting, HR, HRIS or recruiting, legal, procurement or marketing: work measured in deals, relationships or business processes rather than in building or running technology, even when the team sits inside an IT department",
      other: "Anything else, such as product or project management, design, research, or operations not listed above",
    },
  },
  reserved_audience: {
    type: "noul",
    instructions: "Is `posting` open only to members of a particular group of people?",
    criteria: {
      true: "Applications are restricted to a group, for example people with disabilities (PcD), women, Black people, LGBTQIA+ people, veterans, or transitioning service members (such as DoD SkillBridge): an affirmative or exclusive vacancy (vaga afirmativa, vaga exclusiva)",
      false: "Anyone may apply, including postings that encourage or prefer applications from under-represented groups without restricting them. A citizenship, residence, clearance or work-authorisation requirement is not a reserved group.",
    },
  },
  citizenship_required: {
    type: "choice",
    instructions: "Which citizenship, if any, does `posting` require the hire to hold? Being authorised to work in a country, or needing no visa sponsorship, is not a citizenship requirement.",
    criteria: {
      none: "No citizenship is required; at most the hire must be authorised to work somewhere",
      united_states: "US citizenship or US-person status is required",
      european_union: "Citizenship of an EU or EEA country is required",
      united_kingdom: "British citizenship is required",
      brazil: "Brazilian citizenship (nacionalidade brasileira) is required",
      other: "Citizenship of another specific country is required",
    },
  },
  security_clearance: {
    type: "noul",
    instructions: "Does `posting` require the hire to hold, or to be able to obtain, a government security clearance?",
  },
};

/** The full question set. The home country is the one candidate fact it carries. */
export function jevQuestions(homeCountry: string | null): Record<string, JevQuestion> {
  if (!homeCountry) return POSTING_QUESTIONS;
  return {
    ...POSTING_QUESTIONS,
    location_excludes_home: {
      type: "noul",
      instructions: {
        home_country: homeCountry,
        question: "Does `posting` limit where the hire may live or work to countries or regions that leave out `home_country`?",
      },
      criteria: {
        true: "The hire must be based in, reside in, or be employed through specific countries or regions that do not include the home country, for example US only, Canada only, EMEA, or must be located in Europe",
        false: "The posting names the home country or a region containing it, such as LATAM or the Americas, or sets no limit on where the hire may work",
      },
    },
  };
}

/** The posting as Jev sees it — and nothing about the candidate. */
export function postingState(job: Pick<NormalizedJob, "title" | "locationRaw" | "remotePolicy" | "descriptionText">) {
  return {
    posting: {
      title: job.title,
      location: job.locationRaw || "(not stated)",
      workplace: job.remotePolicy,
      description: job.descriptionText.slice(0, MAX_DESCRIPTION_CHARS),
    },
  };
}

// ── Policy: answers about the posting → keep or set aside ───────────────────

/**
 * A yes at least this likely sets the posting aside. A wrongful set-aside
 * loses an application, and the regex gates already catch the plain cases,
 * so the bar is high.
 */
const SET_ASIDE = 0.8;
/** Between this and SET_ASIDE the posting is kept and the doubt is noted for approval. */
const DOUBT = 0.5;
/** Position on the seniority scale (0–4) from which the role reads as staff level. */
const ABOVE_SENIOR = 3.5;
const SENIOR = 3;
/** A title that already says senior: noting "reads as senior" on it tells nobody anything. */
const SENIOR_TITLE = /\b(senior|sr\.?|snr\.?|s[êe]nior|especialista|specialist)\b/i;

export type JevCheck = "reserved-audience" | "level" | "discipline" | "citizenship" | "clearance" | "location" | "pass";

export interface JevVerdict {
  ok: boolean;
  check: JevCheck;
  reason: string;
  /** Kept-but-uncertain readings, written to meta.json notes for the approve step. */
  doubts: string[];
}

const CITIZENSHIP: Record<string, RegExp> = {
  united_states: /^(united states|usa?\b|american)/i,
  united_kingdom: /^(united kingdom|uk\b|british|great britain)/i,
  brazil: /^(brazil|brasil|brazilian|brasileir)/i,
  european_union: EU_CITIZENSHIP,
};

const CITIZENSHIP_NAMES: Record<string, string> = {
  united_states: "US", united_kingdom: "British", brazil: "Brazilian",
  european_union: "EU/EEA", other: "another country's",
};

/** "other" never matches: a country the options do not name cannot be checked. */
function holdsCitizenship(required: string, citizenships: string[]): boolean {
  const re = CITIZENSHIP[required];
  return !!re && citizenships.some((c) => re.test(c.trim()));
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

export interface JevContext {
  /** The posting title, to keep a seniority note to the cases the title hides. */
  title?: string;
  citizenships: string[];
  path: EligibilityPath;
  homeCountry: string | null;
}

/**
 * Pure: the same answers and context always give the same verdict, so the
 * thresholds can be retuned and re-applied to cached answers without asking
 * the model again.
 */
export function judgeJevAnswers(answers: Record<string, JevAnswer | undefined>, ctx: JevContext): JevVerdict {
  const doubts: string[] = [];
  const setAside = (check: JevCheck, reason: string): JevVerdict => ({ ok: false, check, reason, doubts });
  const noul = (id: string) => {
    const a = answers[id];
    return a?.type === "noul" ? a.noul : null;
  };
  const choice = (id: string) => {
    const a = answers[id];
    return a?.type === "choice" ? a : null;
  };

  // Reserved first: whether to apply is the candidate's own decision, and it
  // must not read as a fit failure in the skip list.
  const reserved = noul("reserved_audience");
  if (reserved !== null && reserved >= SET_ASIDE) {
    return setAside("reserved-audience", `Jev reads the posting as reserved for a group (${pct(reserved)}) — left for the candidate to decide`);
  }
  if (reserved !== null && reserved >= DOUBT) doubts.push(`may be reserved for a group (${pct(reserved)})`);

  const level = answers.seniority;
  if (level?.type === "score") {
    if (level.score >= ABOVE_SENIOR) {
      return setAside("level", `Jev places the role at staff or principal level (${level.score.toFixed(1)} on a 0–4 scale)`);
    }
    if (level.score >= SENIOR && !SENIOR_TITLE.test(ctx.title ?? "")) doubts.push(`reads as senior (${level.score.toFixed(1)} on a 0–4 scale)`);
  }

  const manages = noul("manages_people");
  if (manages !== null && manages >= SET_ASIDE) {
    return setAside("level", `Jev reads the role as managing people (${pct(manages)}) — above current level`);
  }
  if (manages !== null && manages >= DOUBT) doubts.push(`may manage people (${pct(manages)})`);

  const discipline = choice("discipline");
  if (discipline) {
    const p = discipline.probabilities[discipline.choice] ?? 0;
    const out = OUT_OF_DISCIPLINE[discipline.choice];
    if (out && p >= SET_ASIDE) {
      return setAside("discipline", `Jev reads the work as ${out} (${pct(p)})`);
    }
    const inField = discipline.probabilities.software_it_security ?? 1;
    if (inField < DOUBT) doubts.push(`may be outside software, IT and security (leans ${discipline.choice}, ${pct(p)})`);
  }

  const citizenship = choice("citizenship_required");
  if (citizenship && citizenship.choice !== "none") {
    const p = citizenship.probabilities[citizenship.choice] ?? 0;
    if (!holdsCitizenship(citizenship.choice, ctx.citizenships)) {
      const name = CITIZENSHIP_NAMES[citizenship.choice] ?? citizenship.choice;
      if (p >= SET_ASIDE) {
        return setAside("citizenship", `Jev reads the posting as requiring ${name} citizenship (${pct(p)}) — not on the candidate's profile`);
      }
      if (p >= DOUBT) doubts.push(`may require ${name} citizenship (${pct(p)})`);
    }
  }

  const clearance = noul("security_clearance");
  if (clearance !== null && clearance >= SET_ASIDE) {
    return setAside("clearance", `Jev reads the posting as requiring a security clearance (${pct(clearance)})`);
  }
  if (clearance !== null && clearance >= DOUBT) doubts.push(`may require a security clearance (${pct(clearance)})`);

  // Only the remote lane depends on where the hire may live; a relocation
  // role's location was already judged by the eligibility classifier.
  const excludesHome = noul("location_excludes_home");
  if (ctx.path === "remote-brazil-eligible" && ctx.homeCountry && excludesHome !== null) {
    if (excludesHome >= SET_ASIDE) {
      return setAside("location", `Jev reads the posting as limited to places outside ${ctx.homeCountry} (${pct(excludesHome)})`);
    }
    if (excludesHome >= DOUBT) doubts.push(`may exclude ${ctx.homeCountry} (${pct(excludesHome)})`);
  }

  return {
    ok: true,
    check: "pass",
    reason: doubts.length ? `kept, with doubts: ${doubts.join("; ")}` : "no objection",
    doubts,
  };
}

// ── Client ─────────────────────────────────────────────────────────────────

export class JevError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "JevError";
  }
}

export interface JevUsage {
  /** Requests actually sent (and billed). */
  calls: number;
  /** Answers served from the local cache. */
  cached: number;
  inputTokens: number;
}

export const jevCostUsd = (u: JevUsage) => u.inputTokens * USD_PER_INPUT_TOKEN;

export function formatJevUsage(u: JevUsage): string {
  return `jev: ${u.calls} call${u.calls === 1 ? "" : "s"}, ${u.cached} cached, ` +
    `${u.inputTokens.toLocaleString("en-US")} input tokens ≈ $${jevCostUsd(u).toFixed(4)}`;
}

export interface JevClientOptions {
  apiKey: string;
  model?: string;
  /** Where answers are cached. null keeps nothing between runs. */
  cacheFile?: string | null;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
}

interface CacheEntry {
  key: string;
  model: string;
  answers: Record<string, JevAnswer>;
  inputTokens: number;
  at: string;
}

export interface JevClient {
  readonly model: string;
  readonly usage: JevUsage;
  ask(state: unknown, questions: Record<string, JevQuestion>): Promise<Record<string, JevAnswer>>;
}

export function createJevClient(opts: JevClientOptions): JevClient {
  const model = opts.model ?? JEV_MODEL;
  const cacheFile = opts.cacheFile === undefined ? JEV_CACHE_FILE : opts.cacheFile;
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const usage: JevUsage = { calls: 0, cached: 0, inputTokens: 0 };
  let cache: Map<string, CacheEntry> | null = null;

  async function loadCache(): Promise<Map<string, CacheEntry>> {
    if (cache) return cache;
    cache = new Map();
    if (!cacheFile) return cache;
    const file = Bun.file(cacheFile);
    if (!(await file.exists())) return cache;
    for (const line of (await file.text()).split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as CacheEntry;
        cache.set(e.key, e);
      } catch {
        // A line cut short by an interrupted run is only a lost cache entry.
      }
    }
    return cache;
  }

  async function post(body: string): Promise<{ answers: Record<string, JevAnswer>; model: string; inputTokens: number }> {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS) throw new JevError(`TypeSafe unreachable: ${(err as Error).message}`);
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      if (res.ok) {
        const json = (await res.json()) as { model: string; answers: Record<string, JevAnswer>; usage?: { input_tokens?: number } };
        return { answers: json.answers, model: json.model, inputTokens: json.usage?.input_tokens ?? 0 };
      }
      // 429 is the rate limit, 529 TypeSafe's own overload signal: both say
      // "later", and retry-after says how much later when it is present.
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < MAX_ATTEMPTS) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** (attempt - 1));
        continue;
      }
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new JevError(
        res.status === 401 ? "TypeSafe rejected the API key (401) — check TYPESAFE_API_KEY in .env" : `TypeSafe HTTP ${res.status}: ${detail}`,
        res.status,
      );
    }
  }

  return {
    model,
    usage,
    async ask(state, questions) {
      const body = JSON.stringify({ state, model, questions });
      const key = createHash("sha256").update(body).digest("hex");
      const entries = await loadCache();
      const hit = entries.get(key);
      if (hit) {
        usage.cached++;
        return hit.answers;
      }
      const res = await post(body);
      usage.calls++;
      usage.inputTokens += res.inputTokens;
      const entry: CacheEntry = { key, model: res.model, answers: res.answers, inputTokens: res.inputTokens, at: new Date().toISOString() };
      entries.set(key, entry);
      if (cacheFile) {
        await mkdir(dirname(cacheFile), { recursive: true });
        await appendFile(cacheFile, JSON.stringify(entry) + "\n");
      }
      return res.answers;
    },
  };
}

/** A client when TYPESAFE_API_KEY is set, otherwise null — the gate is simply off. */
export async function jevClientFromEnv(opts: Omit<JevClientOptions, "apiKey"> = {}): Promise<JevClient | null> {
  const apiKey = await envSetting("TYPESAFE_API_KEY");
  return apiKey ? createJevClient({ ...opts, apiKey }) : null;
}

type PostingText = Pick<NormalizedJob, "title" | "locationRaw" | "remotePolicy" | "descriptionText">;

/**
 * The whole question set, always: the junior check and the review ask the same
 * request, so whichever comes second is a cache hit, not a second bill.
 */
export function askAboutPosting(client: JevClient, job: PostingText): Promise<Record<string, JevAnswer>> {
  return client.ask(postingState(job), jevQuestions(loadPolicy().home.country));
}

/**
 * Highest seniority position (0–4) read as a junior role: the posting leans to
 * "entry level or junior" more than to "mid level".
 */
export const JUNIOR_MAX = 1.5;

/** The seniority Jev read, when it is junior or below — else null. */
export function juniorReading(answers: Record<string, JevAnswer | undefined>): number | null {
  const level = answers.seniority;
  return level?.type === "score" && level.score <= JUNIOR_MAX ? level.score : null;
}

/** Ask about one posting and apply the candidate's policy to the answers. */
export async function reviewWithJev(
  client: JevClient,
  corpus: Corpus,
  job: PostingText,
  path: EligibilityPath,
): Promise<JevVerdict> {
  const homeCountry = loadPolicy().home.country;
  const answers = await askAboutPosting(client, job);
  const declared = corpus.profile.eligibility.citizenship;
  const citizenships = (Array.isArray(declared) ? declared : [declared]).map(String);
  return judgeJevAnswers(answers, { title: job.title, citizenships, path, homeCountry });
}
