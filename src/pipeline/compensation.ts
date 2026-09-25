/**
 * Salary-expectation answers.
 *
 * The default strategy is `low`: when a form insists on a figure, answer at the
 * bottom of the band rather than at the middle, so price is never the reason an
 * application is dropped before a conversation.
 *
 * One interpretation is baked in deliberately. "Low" is resolved against the
 * market band FOR THE ROLE'S REGION, not as an absolute number. Asking for a
 * local-currency salary on a USD remote posting would not read as modest — it
 * would read as someone who does not know the market, and would sink the
 * application for a reason unrelated to price. So `low` means the bottom of the
 * band for the region the role is paid in.
 *
 * Whether to prefer those (blank, "negotiable") over a number is the
 * candidate's call — `compensation.prefer_avoidance` in preferences.yaml. One
 * candidate chose "always a low number"; the default avoids committing.
 *
 * `compensation.caps` bounds the low anchor by the candidate's own level: a
 * form that shows the current salary beside the expectation reads oddly when
 * the band alone asks for more than double it (a senior security band did).
 *
 * Every band here is an ESTIMATE for mid-level platform / security / cloud work
 * and is meant to be tuned in Corpus/preferences.yaml. Nothing here is sourced
 * from a salary survey.
 */

import { loadPolicy } from "../corpus/policy.ts";

export type CompStrategy = "blank" | "negotiable" | "low" | "market-range";

export type CompRegion =
  | "brazil"
  | "latam-remote-usd"
  | "us-remote-usd"
  | "europe-eur"
  | "southern-europe-eur"
  | "nordics-eur"
  | "unknown";

export interface CompBand {
  currency: string;
  period: "year" | "month";
  low: number;
  mid: number;
  high: number;
  note: string;
}

/** Mid-level platform / DevSecOps / cloud bands. Estimates — tune these. */
export const BANDS: Record<CompRegion, CompBand> = {
  brazil: {
    currency: "BRL", period: "month", low: 12000, mid: 16000, high: 22000,
    note: "mid-level infra-security, Brazilian metro",
  },
  "latam-remote-usd": {
    currency: "USD", period: "year", low: 60000, mid: 78000, high: 95000,
    note: "contractor hired remotely from LATAM",
  },
  "us-remote-usd": {
    currency: "USD", period: "year", low: 115000, mid: 140000, high: 170000,
    note: "US-remote mid-level platform/security",
  },
  "europe-eur": {
    currency: "EUR", period: "year", low: 55000, mid: 68000, high: 85000,
    note: "EU mid-level, varies widely by country",
  },
  // Portugal, Spain, Italy, Greece pay well below the EU-wide band; answering
  // the generic European figure there would not be a "low" ask at all.
  "southern-europe-eur": {
    currency: "EUR", period: "year", low: 32000, mid: 42000, high: 55000,
    note: "Portugal/Spain/Italy/Greece mid-level engineering",
  },
  "nordics-eur": {
    currency: "EUR", period: "year", low: 52000, mid: 65000, high: 78000,
    note: "Finland/Nordics mid-level engineering",
  },
  unknown: {
    currency: "USD", period: "year", low: 60000, mid: 78000, high: 95000,
    note: "fallback — treated as LATAM-remote",
  },
};

/**
 * Seniority multiplier, read from the job title.
 *
 * The regional band alone is not enough: "low" for a Staff Platform Engineer
 * posting and "low" for a junior support role are different numbers, and
 * answering the junior figure on a senior req reads as a mismatch rather than a
 * bargain. Multipliers are relative to a mid-level baseline of 1.0.
 */
const SENIORITY: { level: string; mult: number; re: RegExp }[] = [
  { level: "intern", mult: 0.35, re: /\b(intern|internship|trainee|estagi[áa]rio|working student)\b/i },
  { level: "junior", mult: 0.62, re: /\b(junior|jr\.?|entry[- ]level|graduate|associate|j[úu]nior)\b/i },
  { level: "principal", mult: 1.75, re: /\b(principal|staff|distinguished|architect|head of|director)\b/i },
  { level: "lead", mult: 1.55, re: /\b(lead|manager|team lead|tech lead|engineering manager)\b/i },
  { level: "senior", mult: 1.35, re: /\b(senior|sr\.?|s[êe]nior|pleno\/s[êe]nior|experienced|specialist ii|iii)\b/i },
];

/**
 * Role-family multiplier. Security and identity work carries a premium over
 * general IT operations; support work carries a discount.
 */
const ROLE_FAMILY: { family: string; mult: number; re: RegExp }[] = [
  { family: "support", mult: 0.68, re: /\b(help ?desk|service desk|it support|desktop support|technical support|suporte)\b/i },
  { family: "sysadmin", mult: 0.85, re: /\b(system(s)? admin|sysadmin|administrador de sistemas|it operations|infrastructure analyst|analista de infra)/i },
  { family: "architect", mult: 1.25, re: /\b(architect|arquitet[oa]|arquitect[oa])/i },
  { family: "ai", mult: 1.2, re: /\b(machine learning|\bml\b|\bai\b|llm|agent)\b/i },
  { family: "security", mult: 1.12, re: /\b(security|seguran[çc]a|seguridad|iam|identity|identidade|devsecops|grc|compliance|conformidade|soc|incident|pki)\b/i },
  { family: "platform", mult: 1.0, re: /\b(platform|plataforma|devops|sre|site reliability|cloud|nuvem|infrastructure|infraestrutura|infraestructura|kubernetes)\b/i },
  { family: "fullstack", mult: 0.95, re: /\b(full ?stack|frontend|backend|software engineer|developer|desenvolvedor|desarrollador)\b/i },
];

export interface RoleFactor {
  level: string;
  levelMult: number;
  family: string;
  familyMult: number;
  /** Combined multiplier applied to the regional band. */
  mult: number;
}

/** Seniority and family read off the job title, with the combined multiplier. */
export function roleFactor(title: string): RoleFactor {
  const s = SENIORITY.find((x) => x.re.test(title));
  const f = ROLE_FAMILY.find((x) => x.re.test(title));
  const levelMult = s?.mult ?? 1.0;
  const familyMult = f?.mult ?? 1.0;
  return {
    level: s?.level ?? "mid",
    levelMult,
    family: f?.family ?? "general",
    familyMult,
    // Clamped so an unusual title combination cannot produce an absurd figure.
    mult: Math.max(0.3, Math.min(2.2, levelMult * familyMult)),
  };
}

/** Round to something a human would actually type. */
function tidy(amount: number, period: "year" | "month"): number {
  const step = period === "month" ? 500 : 2500;
  return Math.round(amount / step) * step;
}

const EUROPE_HINTS = /\b(europe|european|eu\b|emea|germany|berlin|netherlands|amsterdam|ireland|dublin|spain|madrid|portugal|lisbon|france|paris|poland|warsaw|italy|milan|austria|vienna|belgium|czech|prague|estonia|romania)\b/i;
const SOUTHERN_EU_HINTS = /\b(portugal|lisbon|lisboa|porto|spain|madrid|barcelona|valencia|italy|milan|rome|turin|greece|athens)\b/i;
const NORDIC_HINTS =/\b(finland|helsinki|espoo|tampere|sweden|stockholm|denmark|copenhagen|norway|oslo|iceland|reykjavik|nordics?)\b/i;
const US_HINTS = /\b(united states|\busa?\b|new york|san francisco|seattle|austin|boston|chicago|denver|remote - us|remote, us)\b/i;
const BRAZIL_HINTS = /\b(brazil|brasil|são paulo|sao paulo|rio de janeiro)\b/i;
const LATAM_HINTS = /\b(latam|latin america|south america|americas|amer\b|mexico|argentina|colombia|chile)\b/i;

export function classifyRegion(locationRaw: string, descriptionText = ""): CompRegion {
  const loc = `${locationRaw} ${descriptionText.slice(0, 800)}`;
  if (NORDIC_HINTS.test(locationRaw)) return "nordics-eur";
  if (SOUTHERN_EU_HINTS.test(locationRaw)) return "southern-europe-eur";
  if (EUROPE_HINTS.test(locationRaw)) return "europe-eur";
  if (BRAZIL_HINTS.test(locationRaw)) return "brazil";
  if (US_HINTS.test(locationRaw)) return "us-remote-usd";
  if (LATAM_HINTS.test(locationRaw)) return "latam-remote-usd";
  if (NORDIC_HINTS.test(loc)) return "nordics-eur";
  if (EUROPE_HINTS.test(loc)) return "europe-eur";
  if (US_HINTS.test(loc)) return "us-remote-usd";
  return "unknown";
}

export interface CompAnswerOptions {
  /** Job title — drives the seniority and role-family multipliers. */
  title?: string;
  strategy?: CompStrategy;
  /** Use blank/"negotiable" whenever the form permits it. */
  preferAvoidance?: boolean;
  /** True when the form will not submit without a number. */
  numberRequired?: boolean;
  /** True when the field accepts free text rather than digits only. */
  acceptsText?: boolean;
  lang?: "en" | "pt" | "es";
}

export interface CompAnswer {
  /** Exactly what to type into the field. Empty string means leave blank. */
  value: string;
  /** Digits only, for numeric-only fields. */
  numeric: number | null;
  currency: string;
  period: "year" | "month";
  region: CompRegion;
  strategy: CompStrategy;
  /** How the title shifted the regional band. */
  role: RoleFactor;
  reason: string;
}

const TEXT: Record<"en" | "pt" | "es", { negotiable: string; from: (a: string) => string }> = {
  en: {
    negotiable: "Negotiable — open to discussing based on the full scope of the role.",
    from: (a) => `From ${a}, negotiable based on scope.`,
  },
  pt: {
    negotiable: "Negociável — aberto a discutir conforme o escopo da posição.",
    from: (a) => `A partir de ${a}, negociável conforme o escopo.`,
  },
  es: {
    negotiable: "Negociable — abierto a conversarlo según el alcance del puesto.",
    from: (a) => `Desde ${a}, negociable según el alcance.`,
  },
};

function formatAmount(band: CompBand, amount: number, lang: "en" | "pt" | "es" = "en"): string {
  // Brazilian forms read reais the Brazilian way: "R$ 13.000/mês".
  if (band.currency === "BRL") {
    const n = new Intl.NumberFormat("pt-BR").format(amount);
    const per = band.period === "month" ? (lang === "en" ? "/month" : lang === "es" ? "/mes" : "/mês") : lang === "en" ? "/year" : "/ano";
    return `R$ ${n}${per}`;
  }
  const n = new Intl.NumberFormat("en-US").format(amount);
  const per = band.period === "month" ? "/month" : "/year";
  return `${band.currency} ${n}${per}`;
}



/**
 * Decide what to put in a salary field.
 *
 * Order of preference when `preferAvoidance` is on: leave blank if the field is
 * optional, say "negotiable" if it takes text, and only then commit to a number.
 * A number cannot be withdrawn; the other two can.
 */
export function answerSalary(
  locationRaw: string,
  descriptionText = "",
  opts: CompAnswerOptions = {},
): CompAnswer {
  const strategy = opts.strategy ?? "low";
  const preferAvoidance = opts.preferAvoidance ?? loadPolicy().compensation.preferAvoidance;
  const lang = opts.lang ?? "en";
  const region = classifyRegion(locationRaw, descriptionText);
  const raw = BANDS[region];
  const role = roleFactor(opts.title ?? "");
  const t = TEXT[lang];

  // The regional band scaled to this specific role. "Low" on a Staff Security
  // req and "low" on a junior support req are different numbers.
  const band: CompBand = {
    ...raw,
    low: tidy(raw.low * role.mult, raw.period),
    mid: tidy(raw.mid * role.mult, raw.period),
    high: tidy(raw.high * role.mult, raw.period),
  };
  const cap = loadPolicy().compensation.caps[region]?.[role.level];
  if (cap !== undefined && band.low > cap) band.low = cap;

  const base = { currency: band.currency, period: band.period, region, strategy, role };

  if (strategy === "blank" || (preferAvoidance && !opts.numberRequired && !opts.acceptsText)) {
    return {
      ...base, value: "", numeric: null,
      reason: "campo não obrigatório — deixado em branco para não ancorar a negociação",
    };
  }

  if (strategy === "negotiable" || (preferAvoidance && !opts.numberRequired && opts.acceptsText)) {
    return {
      ...base, value: t.negotiable, numeric: null,
      reason: "campo aceita texto — respondido sem cravar um número",
    };
  }

  if (strategy === "market-range") {
    return {
      ...base,
      value: `${formatAmount(band, band.mid)} – ${formatAmount(band, band.high)}`,
      numeric: band.mid,
      reason: `faixa de mercado para ${region}, ${role.level}/${role.family} (×${role.mult.toFixed(2)})`,
    };
  }

  // `low` — the candidate's stated preference. Bottom of the band FOR THAT REGION.
  const amount = band.low;
  return {
    ...base,
    value: opts.acceptsText ? t.from(formatAmount(band, amount, lang)) : String(amount),
    numeric: amount,
    reason:
      `âncora baixa: piso da faixa ${region} ajustada para ${role.level}/${role.family} ` +
      `(×${role.mult.toFixed(2)} = nível ${role.levelMult} × família ${role.familyMult}). ` +
      `Relativa à região e ao tipo de vaga, nunca absoluta.`,
  };
}

// `bun run src/pipeline/compensation.ts` — see what each region would answer.
if (import.meta.main) {
  const cases: [string, string][] = [
    ["São Paulo, Brazil", "Analista de Suporte de TI Júnior"],
    ["São Paulo, Brazil", "Engenheiro de Plataforma Sênior"],
    ["Remote, LATAM", "Platform Engineer"],
    ["Remote, LATAM", "Senior Security Engineer, IAM"],
    ["Remote - US", "Staff Platform Engineer"],
    ["Helsinki, Finland", "Linux Systems Engineer – Identity, PKI & Security"],
    ["Helsinki, Finland", "Junior Security Engineer, GRC"],
  ];
  console.log("estratégia padrão: low — piso da faixa da REGIÃO ajustado ao TIPO da vaga\n");
  for (const [loc, title] of cases) {
    const lang = /Brazil|Brasil/i.test(loc) ? "pt" as const : "en" as const;
    const a = answerSalary(loc, "", { title, numberRequired: true, lang });
    const txt = answerSalary(loc, "", { title, acceptsText: true, lang });
    console.log(`${title}`);
    console.log(`   @ ${loc}  →  ${a.region} | ${a.role.level}/${a.role.family} ×${a.role.mult.toFixed(2)}`);
    console.log(`   numérico: ${a.currency} ${Number(a.value).toLocaleString("en-US")}${a.period === "month" ? "/mês" : "/ano"}`);
    console.log(`   texto:    "${txt.value}"\n`);
  }
}
