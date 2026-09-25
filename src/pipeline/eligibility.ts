/**
 * Personal eligibility policy.
 *
 * `src/ats/remote.ts` answers a factual question: can this posting be worked
 * from Brazil? This module answers the candidate's question: would he take it?
 * Keeping them apart means the ATS layer stays a neutral classifier and the
 * policy can change without touching adapters.
 *
 * The policy this module applies, read from the corpus:
 *   - remote roles open to Brazil / LATAM / Americas / worldwide  → yes
 *   - hybrid or onsite in the EU/EEA                              → yes, NO sponsorship
 *   - hybrid or onsite in the US or UK                            → yes, sponsorship needed
 *   - hybrid or onsite anywhere else, Brazil included             → no
 *
 * The decisive fact is whether the profile declares an EU citizenship. With one,
 * EU/EEA roles need no visa and the application is a local one rather than a
 * relocation case: "will you require sponsorship?" is the question that
 * eliminates the most applicants, and there the answer is no. The UK is excluded
 * either way — post-Brexit an EU passport no longer grants work rights there.
 *
 * US roles remain genuine relocation: sponsorship, long timelines, low hit rate.
 * They stay in their own lane so they never distort the measurement.
 */

import type { NormalizedJob } from "../ats/types.ts";
import { isBrazilEligible } from "../ats/remote.ts";
import { loadPolicy, type Policy } from "../corpus/policy.ts";

export type EligibilityPath =
  | "remote-brazil-eligible"
  | "brazil-local"        // hybrid/onsite within commuting distance of home
  | "relocation-europe"
  | "relocation-us"       // place-bound OR remote-US-only; always needs sponsorship
  | "none";

export interface EligibilityVerdict {
  eligible: boolean;
  path: EligibilityPath;
  /** True when taking the role would require a work visa. */
  requiresSponsorship: boolean;
  reason: string;
}

const EUROPE = [
  "europe", "european union", "\\beu\\b", "emea",
  "united kingdom", "\\buk\\b", "england", "scotland", "london", "manchester",
  "ireland", "dublin", "germany", "berlin", "munich", "hamburg", "frankfurt",
  "netherlands", "amsterdam", "utrecht", "rotterdam",
  "france", "paris", "lyon", "spain", "madrid", "barcelona",
  "portugal", "lisbon", "\\bporto\\b(?! alegre| seguro| velho| belo)", "italy", "milan", "rome",
  "poland", "warsaw", "krakow", "sweden", "stockholm", "denmark", "copenhagen",
  "norway", "oslo", "finland", "helsinki", "switzerland", "zurich", "geneva",
  "austria", "vienna", "belgium", "brussels", "czech", "prague",
  "romania", "bucharest", "estonia", "tallinn", "lithuania", "vilnius",
];

const US = [
  "united states", "\\busa\\b", "\\bu\\.s\\.", "\\bus\\b",
  "new york", "\\bnyc\\b", "san francisco", "bay area", "seattle", "austin",
  "boston", "chicago", "denver", "atlanta", "los angeles", "san diego",
  "portland", "miami", "dallas", "houston", "phoenix", "philadelphia",
  "washington, dc", "washington dc", "\\bd\\.c\\.", "remote - us", "remote, us",
];

const BRAZIL = [
  "brazil", "brasil", "são paulo", "sao paulo", "rio de janeiro", "belo horizonte",
  "curitiba", "porto alegre", "campinas", "florianópolis", "florianopolis",
  "recife", "brasília", "brasilia", "barueri", "osasco", "\\bsp\\b, br",
];

const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

/**
 * Whether a place-bound location in the home country is one the candidate would
 * work in: their home area (`home.cities`) or a city they would move to
 * (`relocation.within_country`), both in preferences.yaml. With neither set,
 * any city is accepted. Without the list, a Gupy sweep had queued support
 * roles in cities the candidate had never offered to move to.
 *
 * Gupy writes "City, State, Country", where the state can read as a city —
 * "Campinas, São Paulo, Brasil" is Campinas — so that shape is read by its first
 * part. Other shapes ("Buenos Aires, Sao Paulo, Montevideo") list alternatives,
 * and any accepted one will do.
 */
export function brazilCityAccepted(location: string, policy: Policy = loadPolicy()): boolean {
  return namesAcceptedCity(location, [...policy.home.cities, ...policy.relocation.withinCountry]);
}

/** Whether a location is in the candidate's home area — a role there needs no move. */
export function inHomeArea(location: string, policy: Policy = loadPolicy()): boolean {
  return policy.home.cities.length > 0 && namesAcceptedCity(location, policy.home.cities);
}

function namesAcceptedCity(location: string, cities: string[]): boolean {
  const accepted = cities.map(fold);
  if (accepted.length === 0) return true;
  // "ABC Paulista (São Bernardo, …)" and "Embu das Artes" read as the listed name.
  const ok = (city: string) => {
    const c = fold(city);
    return accepted.some((a) => c === a || c.startsWith(`${a} `) || c.startsWith(`${a}(`));
  };
  const parts = location
    .replace(/\((hybrid|h[íi]brido|onsite|on-site|presencial|remote|remoto)\)|\b(hybrid|h[íi]brido|onsite|presencial)\b/gi, "")
    .split(/\s*[,/|;]\s*|\s+[-–]\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return true;
  if (parts.length === 3 && /^bra[sz]il$/i.test(parts[2]!)) return ok(parts[0]!);
  const named = parts.filter((p) => !/^(bra[sz]il|sp|rj|pr|latam|latin america)$/i.test(p));
  // "Brazil" alone names no city: nothing rules it out.
  return named.length === 0 || named.some(ok);
}

function matches(haystack: string, patterns: string[]): string | null {
  for (const p of patterns) {
    const re = new RegExp(p, "i");
    if (re.test(haystack)) return p.replace(/\\b|\\./g, "");
  }
  return null;
}

export function classifyEligibility(job: NormalizedJob): EligibilityVerdict {
  const location = job.locationRaw ?? "";
  const isPlaceBound = job.remotePolicy === "hybrid" || job.remotePolicy === "onsite";

  // Place-bound roles are judged FIRST. Checking Brazil-eligibility first would
  // accept any hybrid role in the home country — the location is Brazil, so the
  // ATS-level classifier says yes — while the policy accepts place-bound work
  // only in the accepted cities, Europe or the US. Order matters here.
  if (!isPlaceBound) {
    const brazil = isBrazilEligible(job);
    if (brazil.eligible) {
      return {
        eligible: true,
        path: "remote-brazil-eligible",
        requiresSponsorship: false,
        reason: brazil.reason,
      };
    }
  }

  // Relocation. Only hybrid/onsite roles in Europe or the US qualify; a
  // remote-but-US-only posting is not a relocation opportunity, it is simply
  // closed to the candidate.
  if (isPlaceBound) {
    const eu = matches(location, EUROPE);
    if (eu) {
      // An EU citizenship means EU work rights with no sponsorship. The UK is
      // the exception — post-Brexit an EU passport no longer grants work rights
      // there, so it is treated as a sponsorship market like the US.
      // A multi-office posting is only UK-bound if EVERY European option is in
      // the UK. "San Francisco, London, Berlin" can be worked from Berlin with no
      // visa; checking for any UK mention marked it sponsorship-required and
      // filtered a winnable role.
      const UK_ONLY = /^(united kingdom|uk|england|scotland|wales|london|manchester)$/i;
      const nonUkEu = EUROPE.filter((p) => !UK_ONLY.test(p.replace(/\\b/g, "")))
        .map((p) => location.match(new RegExp(p, "i"))?.[0])
        .find(Boolean);
      const isUK = !nonUkEu && /\b(united kingdom|uk|england|scotland|wales|london|manchester)\b/i.test(location);
      // Without an EU citizenship, every European role is a sponsorship case.
      const euRights = loadPolicy().euWorkRights;
      return {
        eligible: true,
        path: "relocation-europe",
        requiresSponsorship: isUK || !euRights,
        reason: isUK
          ? `${job.remotePolicy} in the UK ("${location}") — EU citizenship does not cover the UK post-Brexit, sponsorship required`
          : euRights
            ? `${job.remotePolicy} in the EU ("${location}" matched "${nonUkEu ?? eu}") — EU citizenship, NO sponsorship needed`
            : `${job.remotePolicy} in the EU ("${location}") — no EU citizenship on the profile, sponsorship required`,
      };
    }
    const us = matches(location, US);
    if (us) {
      return {
        eligible: true,
        path: "relocation-us",
        requiresSponsorship: true,
        reason: `${job.remotePolicy} in the US ("${location}" matched "${us}") — requires relocation and sponsorship`,
      };
    }
    // Place-bound at home: an onsite or hybrid role in the home country needs
    // no visa and no relocation abroad, provided it is in a city the candidate
    // accepts (preferences home.cities and relocation.within_country).
    const br = matches(location, BRAZIL);
    if (br && !brazilCityAccepted(location)) {
      return {
        eligible: false,
        path: "none",
        requiresSponsorship: false,
        reason: `${job.remotePolicy} in Brazil outside the candidate's home area and relocation cities ("${location}")`,
      };
    }
    if (br) {
      return {
        eligible: true,
        path: "brazil-local",
        requiresSponsorship: false,
        reason: `${job.remotePolicy} in Brazil ("${location}" matched "${br}") — citizen, within the accepted home area`,
      };
    }
    return {
      eligible: false,
      path: "none",
      requiresSponsorship: false,
      reason: `${job.remotePolicy} role outside Europe/US/Brazil ("${location}") — place-bound work is accepted only there`,
    };
  }

  // Remote but US-only: it needs sponsorship exactly like a place-bound US
  // role, and forms are answered that way.
  const usRemote = matches(location, US);
  if (usRemote) {
    return {
      eligible: true,
      path: "relocation-us",
      requiresSponsorship: true,
      reason: `remote, US-only ("${location}" matched "${usRemote}") — requires US work authorization, i.e. sponsorship`,
    };
  }

  return {
    eligible: false,
    path: "none",
    requiresSponsorship: false,
    reason: isBrazilEligible(job).reason,
  };
}
