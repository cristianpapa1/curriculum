/**
 * Remote-policy classification and Brazil work-eligibility screening.
 *
 * Both functions are deliberately transparent: eligibility returns the phrase that
 * decided the verdict, so a human can audit why a posting was kept or dropped.
 */

import type { BrazilEligibility, NormalizedJob, RemotePolicy } from './types.ts';

/**
 * ATS-native hints. `isRemote` alone is unreliable — Ashby returns `isRemote: true`
 * together with `workplaceType: "Hybrid"` on the same posting (verified live against
 * api.ashbyhq.com/posting-api/job-board/ramp) — so `workplaceType` outranks it.
 */
export interface RemoteHints {
  isRemote?: boolean;
  /** ATS-native workplace label, e.g. "Remote" | "Hybrid" | "OnSite". */
  workplaceType?: string;
  /** SmartRecruiters exposes an explicit hybrid boolean. */
  isHybrid?: boolean;
}

const HYBRID_PATTERN = /\bhybrid\b/i;
const REMOTE_PATTERN = /\bremote\b|\bwork from home\b|\bwfh\b|\bdistributed\b|\btelecommute\b/i;
/** "Remote" that is actually a denial, e.g. "this role is not remote". */
const REMOTE_NEGATION_PATTERN = /\b(not|non|no)[\s-]+remote\b|\bremote\s+is\s+not\b|\bnot\s+a\s+remote\b/i;
const ONSITE_PATTERN = /\bon[\s-]?site\b|\bin[\s-]office\b|\bin[\s-]person\b/i;

/** Normalize an ATS workplace label into our vocabulary. Returns null when unrecognized. */
function policyFromWorkplaceType(workplaceType: string | undefined): RemotePolicy | null {
  if (workplaceType === undefined) return null;
  const value = workplaceType.trim().toLowerCase().replace(/[\s_-]/g, '');
  if (value === 'remote') return 'remote';
  if (value === 'hybrid') return 'hybrid';
  if (value === 'onsite' || value === 'inoffice' || value === 'inperson') return 'onsite';
  return null;
}

/**
 * Classify a posting's remote policy.
 *
 * Precedence: ATS-native `workplaceType` -> location text -> `isHybrid`/`isRemote`
 * flags -> description text -> `unknown`. Location text outranks the boolean flags
 * because boards set the flags inconsistently while the location string is what the
 * posting actually advertises.
 */
export function classifyRemote(
  locationRaw: string,
  descriptionText: string,
  extra?: RemoteHints,
): RemotePolicy {
  const nativePolicy = policyFromWorkplaceType(extra?.workplaceType);
  if (nativePolicy !== null) return nativePolicy;

  const location = typeof locationRaw === 'string' ? locationRaw : '';
  const description = typeof descriptionText === 'string' ? descriptionText : '';

  if (HYBRID_PATTERN.test(location)) return 'hybrid';
  if (REMOTE_PATTERN.test(location) && !REMOTE_NEGATION_PATTERN.test(location)) return 'remote';
  if (ONSITE_PATTERN.test(location)) return 'onsite';

  if (extra?.isHybrid === true) return 'hybrid';
  if (extra?.isRemote === true) return 'remote';

  // Description is the weakest signal: only the opening section is considered, because
  // boilerplate further down ("we are a remote-friendly company") describes the employer,
  // not this role.
  const descriptionHead = description.slice(0, 600);
  if (HYBRID_PATTERN.test(descriptionHead)) return 'hybrid';
  if (REMOTE_PATTERN.test(descriptionHead) && !REMOTE_NEGATION_PATTERN.test(descriptionHead)) {
    return 'remote';
  }

  // A concrete place name with no remote/hybrid marker means the role sits somewhere.
  if (location.trim().length > 0) return 'onsite';
  if (extra?.isRemote === false) return 'onsite';

  return 'unknown';
}

/* ────────────────────────────────────────────────────────────────────────────
 * Brazil work eligibility
 *
 * Governing rule, learned from live multi-company probing: an explicit location
 * enumeration outranks anything the description says. Company marketing ("globally
 * distributed", "fully distributed team", "work from anywhere") describes the employer,
 * not the work authorization attached to a specific requisition.
 *
 * Live failures this ordering fixes:
 *   greenhouse/gitlab    "Remote, Canada; Remote, United Kingdom; Remote, United States"
 *                        was eligible via description "fully distributed team"
 *   greenhouse/cloudflare "Hybrid" was eligible via description "globally distributed"
 *   ashby/supabase       "Remote, EMEA" was eligible via description "work from anywhere"
 * ──────────────────────────────────────────────────────────────────────────── */

interface EligibilityRule {
  pattern: RegExp;
}

/** Hard work-authorization restrictions. These win wherever they appear. */
const EXCLUSION_RULES: readonly EligibilityRule[] = [
  { pattern: /\bU\.?S\.?\s*(?:only|based only)\b/i },
  { pattern: /\bUSA\s*only\b/i },
  { pattern: /\bUnited States\s*only\b/i },
  { pattern: /\bmust (?:be|reside)\s+(?:located|based)?\s*(?:in|within)\s+the\s+(?:United States|U\.?S\.?A?\.?)\b/i },
  { pattern: /\bmust reside in the\s+(?:United States|U\.?S\.?A?\.?)\b/i },
  { pattern: /\b(?:requires?|require)\s+(?:U\.?S\.?|United States)\s+work authorization\b/i },
  { pattern: /\b(?:U\.?S\.?|United States)\s+work authorization\s+(?:is\s+)?required\b/i },
  { pattern: /\bmust be (?:legally )?authorized to work in the\s+(?:United States|U\.?S\.?A?\.?)\b/i },
  { pattern: /\bmust be a\s+(?:U\.?S\.?|United States)\s+citizen\b/i },
  { pattern: /\b(?:U\.?S\.?|United States)\s+citizens?\s+only\b/i },
  { pattern: /\bany(?:where)?\s+(?:in|within)\s+the\s+(?:United States|U\.?S\.?A?\.?)\b/i },
  { pattern: /\bremote (?:from|in|within) the\s+(?:United States|U\.?S\.?A?\.?)\b/i },
  { pattern: /\bUS[-\s]Remote\b/i },
  { pattern: /\bEU\s*only\b/i },
  { pattern: /\bEuropean Union\s*only\b/i },
  { pattern: /\bmust (?:be|reside)\s+(?:located|based)?\s*(?:in|within)\s+the\s+(?:EU|European Union|United Kingdom|UK)\b/i },
  { pattern: /\bUK\s*only\b/i },
  { pattern: /\bCanada\s*only\b/i },
  { pattern: /\bIndia\s*only\b/i },
  { pattern: /\bEMEA\s*only\b/i },
  { pattern: /\bAPAC\s*only\b/i },
];

/** Location wording that requires physical office presence. */
const OFFICE_PRESENCE_PATTERN = /\b(?:hybrid|on[\s-]?site|in[\s-]?office|in[\s-]person)\b/i;

/**
 * Unambiguous Brazil-reaching geography. Trusted in a location even alongside an
 * office-presence marker, because a hybrid role in Sao Paulo is reachable from Brazil.
 */
const STRONG_GEO_PATTERN = /\b(?:brazil|brasil|latam|latin america|south america)\b/i;

/**
 * Location tokens that put Brazil in scope.
 *
 * `Americas` is plural and `AMER`/`AMERS` are word-bounded on purpose: neither matches
 * "North America", which is a US/Canada bloc that excludes Brazil.
 */
const LOCATION_ELIGIBLE_PATTERN =
  /\b(?:brazil|brasil|latam|latin america|south america|americas|amers?|global|globally|worldwide|anywhere)\b/i;

/** Blocs that explicitly exclude Brazil, checked so they cannot be read as generic. */
const BLOC_EXCLUDES_BRAZIL_PATTERN = /\b(?:emea|apac|anz|apj|north america|namer)\b/i;

/** Location fragments carrying no geography at all. */
const LOCATION_FILLER_PATTERN =
  /^(?:remote|fully remote|remote work|remote worker|work from home|wfh|distributed|telecommute|telecommuting|flexible|multiple locations|various locations|various|any|n\/?a|tbd|-|–|—)$/i;

/**
 * Description phrases that state hiring scope explicitly.
 * Consulted only when the location says nothing — bare "global" never qualifies.
 */
const DESCRIPTION_SCOPE_RULES: readonly EligibilityRule[] = [
  { pattern: /\bwork from anywhere in the world\b/i },
  { pattern: /\bfrom anywhere in the world\b/i },
  { pattern: /\banywhere in the world\b/i },
  { pattern: /\bwork from anywhere\b/i },
  { pattern: /\bremote\s*[-–—:]\s*worldwide\b/i },
  { pattern: /\bwe hire (?:from )?(?:globally|worldwide|anywhere)\b/i },
  { pattern: /\bhire (?:globally|worldwide|anywhere)\b/i },
  { pattern: /\bopen to candidates (?:from |in )?anywhere\b/i },
];

/** Run an ordered rule list, returning the literal text that matched. */
function firstMatch(haystack: string, rules: readonly EligibilityRule[]): string | null {
  for (const rule of rules) {
    const match = rule.pattern.exec(haystack);
    if (match !== null && match[0].length > 0) {
      return match[0].replace(/\s+/g, ' ').trim();
    }
  }
  return null;
}

/** Split a location string into its enumerated parts. */
function splitLocationTokens(location: string): string[] {
  return location
    .split(/[;,/|]|\s+or\s+/i)
    .map((token) => token.replace(/[()\[\]]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((token) => token.length > 0);
}

/**
 * True when the location names at least one real place or bloc.
 *
 * A qualified location decides eligibility by itself. An unqualified one — empty, or a
 * bare "Remote" with no region attached — hands the decision to the description.
 */
function isQualifiedLocation(tokens: readonly string[]): boolean {
  return tokens.some((token) => !LOCATION_FILLER_PATTERN.test(token));
}

/** Quote a location for inclusion in a reason string. */
function quoteLocation(location: string): string {
  return location.trim().length > 0 ? `"${location.trim()}"` : '(empty)';
}

/**
 * Decide whether a Brazil-based candidate can hold this role.
 *
 * Order of reasoning:
 *   1. An explicit work-authorization exclusion anywhere in the posting wins outright.
 *   2. An office-presence location (hybrid/onsite) is out unless the location itself
 *      names Brazil or LATAM.
 *   3. A qualified location decides the case alone — description text cannot override
 *      an enumerated country list.
 *   4. Only an empty or bare-"Remote" location defers to the description, and then only
 *      to phrases that actually state hiring scope.
 *
 * The default is `false`: silence is not permission. A false negative costs one skipped
 * application; a false positive costs an hour of tailoring and a certain rejection.
 */
export function isBrazilEligible(job: NormalizedJob): BrazilEligibility {
  const location = typeof job.locationRaw === 'string' ? job.locationRaw : '';
  const description = typeof job.descriptionText === 'string' ? job.descriptionText : '';

  const locationExclusion = firstMatch(location, EXCLUSION_RULES);
  if (locationExclusion !== null) {
    return { eligible: false, reason: `location:${quoteLocation(location)} excludes Brazil ("${locationExclusion}")` };
  }

  const descriptionExclusion = firstMatch(description, EXCLUSION_RULES);
  if (descriptionExclusion !== null) {
    return { eligible: false, reason: `description:"${descriptionExclusion}" excludes Brazil` };
  }

  const strongGeo = STRONG_GEO_PATTERN.exec(location);

  if (OFFICE_PRESENCE_PATTERN.test(location) && strongGeo === null) {
    return {
      eligible: false,
      reason: `location:${quoteLocation(location)} requires office presence outside Brazil`,
    };
  }

  const tokens = splitLocationTokens(location);

  if (isQualifiedLocation(tokens)) {
    if (strongGeo !== null) {
      return { eligible: true, reason: `location:${quoteLocation(location)} matched "${strongGeo[0]}"` };
    }

    // A bloc that excludes Brazil is decided before the generic tokens, so
    // "Remote, EMEA" can never be read as an open-ended remote posting.
    const bloc = BLOC_EXCLUDES_BRAZIL_PATTERN.exec(location);
    if (bloc !== null) {
      return {
        eligible: false,
        reason: `location:${quoteLocation(location)} excludes Brazil ("${bloc[0]}")`,
      };
    }

    const eligibleToken = LOCATION_ELIGIBLE_PATTERN.exec(location);
    if (eligibleToken !== null) {
      return { eligible: true, reason: `location:${quoteLocation(location)} matched "${eligibleToken[0]}"` };
    }

    return { eligible: false, reason: `location:${quoteLocation(location)} excludes Brazil` };
  }

  // Location is empty or a bare "Remote": the description may decide.
  if (job.remotePolicy === 'onsite' || job.remotePolicy === 'hybrid') {
    return { eligible: false, reason: `remotePolicy:"${job.remotePolicy}" requires office presence` };
  }

  const strongInDescription = STRONG_GEO_PATTERN.exec(description);
  if (strongInDescription !== null) {
    return { eligible: true, reason: `description:"${strongInDescription[0]}"` };
  }

  const scopePhrase = firstMatch(description, DESCRIPTION_SCOPE_RULES);
  if (scopePhrase !== null) {
    return { eligible: true, reason: `description:"${scopePhrase}"` };
  }

  return { eligible: false, reason: 'no Brazil, LATAM or worldwide eligibility signal found' };
}
