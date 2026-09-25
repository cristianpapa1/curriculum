/**
 * Locale selection and localized document chrome.
 *
 * Document language follows the posting's market:
 *   - Brazil                        → Portuguese (pt-BR)
 *   - Spanish-speaking LATAM + Mexico → Spanish (es)
 *   - everywhere else               → English (en)
 *
 * Design note: there is no runtime LLM in this environment (no API key, no
 * `claude` CLI), so translation is NOT done at render time. Localized text
 * lives in the corpus and in the tables below, which keeps rendering
 * deterministic and — more importantly — keeps the anti-fabrication gate
 * meaningful, since a machine translation performed after the gate would be
 * unverifiable. Numbers and technology names are never translated; the
 * integrity check in `checkTranslationIntegrity` enforces that.
 */

import type { NormalizedJob } from "../ats/types.ts";

export type Lang = "en" | "pt" | "es";

const BRAZIL = [
  "brazil", "brasil", "\\bbr\\b", "são paulo", "sao paulo", "rio de janeiro",
  "belo horizonte", "brasília", "brasilia", "curitiba", "porto alegre",
  "recife", "fortaleza", "salvador", "campinas", "florianópolis", "florianopolis",
];

/** Spanish-speaking Latin America, including Mexico. */
const SPANISH_LATAM = [
  "mexico", "méxico", "ciudad de méxico", "cdmx", "guadalajara", "monterrey",
  "argentina", "buenos aires", "córdoba", "cordoba",
  "colombia", "bogotá", "bogota", "medellín", "medellin",
  "chile", "santiago", "peru", "perú", "lima",
  "uruguay", "montevideo", "ecuador", "quito", "guayaquil",
  "costa rica", "san josé, costa rica", "panama", "panamá",
  "guatemala", "dominican republic", "república dominicana",
  "bolivia", "paraguay", "asunción", "asuncion", "venezuela", "caracas",
  "el salvador", "honduras", "nicaragua", "puerto rico",
];

function matchAny(haystack: string, patterns: string[]): string | null {
  const h = haystack.toLowerCase();
  for (const p of patterns) {
    if (new RegExp(p, "i").test(h)) return p.replace(/\\b/g, "");
  }
  return null;
}

export interface LocaleDecision {
  lang: Lang;
  reason: string;
}

/**
 * Choose the document language for a posting.
 *
 * Brazil is checked first: "LATAM" alone stays English because a pan-regional
 * req is nearly always posted and screened in English, and guessing Spanish for
 * a Brazilian applicant would be actively wrong.
 */
export function chooseLocale(job: Pick<NormalizedJob, "locationRaw" | "descriptionText">): LocaleDecision {
  const location = job.locationRaw ?? "";

  const br = matchAny(location, BRAZIL);
  if (br) return { lang: "pt", reason: `location "${location}" matched Brazil ("${br}")` };

  const es = matchAny(location, SPANISH_LATAM);
  if (es) return { lang: "es", reason: `location "${location}" matched Spanish-speaking LATAM ("${es}")` };

  // Fall back to the description only for a country name, never for a stray
  // city mention in boilerplate.
  const body = (job.descriptionText ?? "").slice(0, 1500);
  const brBody = matchAny(body, ["\\bbrazil\\b", "\\bbrasil\\b"]);
  if (brBody && /brazil|brasil/i.test(location + body.slice(0, 300))) {
    return { lang: "pt", reason: `description names Brazil ("${brBody}")` };
  }

  return { lang: "en", reason: `no Brazil or Spanish-LATAM signal in "${location}" — defaulting to English` };
}

/** Section headings and fixed labels, per language. */
export interface ChromeStrings {
  summary: string;
  highlights: string;
  experience: string;
  projects: string;
  skills: string;
  certifications: string;
  education: string;
  languages: string;
  present: string;
  core: string;
  proficient: string;
  working: string;
  inProgress: string;
  certified: string;
  native: string;
  salutation: string;
  hiringManager: string;
  signoff: string;
}

export const CHROME: Record<Lang, ChromeStrings> = {
  en: {
    summary: "Summary",
    highlights: "Selected Achievements",
    experience: "Experience",
    projects: "Independent Projects",
    skills: "Skills",
    certifications: "Certifications",
    education: "Education",
    languages: "Languages",
    present: "Present",
    core: "Core",
    proficient: "Proficient",
    working: "Working knowledge",
    inProgress: "in progress, expected",
    certified: "certified",
    native: "Native",
    salutation: "Dear",
    hiringManager: "Hiring Manager",
    signoff: "Sincerely,",
  },
  pt: {
    summary: "Resumo",
    highlights: "Principais Resultados",
    experience: "Experiência Profissional",
    projects: "Projetos Independentes",
    skills: "Competências Técnicas",
    certifications: "Certificações",
    education: "Formação Acadêmica",
    languages: "Idiomas",
    present: "Atual",
    core: "Principais",
    proficient: "Proficiente",
    working: "Conhecimento prático",
    inProgress: "em andamento, conclusão prevista para",
    certified: "certificado",
    native: "Nativo",
    salutation: "Prezado(a)",
    hiringManager: "Responsável pela Contratação",
    signoff: "Atenciosamente,",
  },
  es: {
    summary: "Resumen",
    highlights: "Principales Logros",
    experience: "Experiencia Profesional",
    projects: "Proyectos Independientes",
    skills: "Competencias Técnicas",
    certifications: "Certificaciones",
    education: "Formación Académica",
    languages: "Idiomas",
    present: "Actual",
    core: "Principales",
    proficient: "Competente",
    working: "Conocimiento práctico",
    inProgress: "en curso, finalización prevista para",
    certified: "certificado",
    native: "Nativo",
    salutation: "Estimado/a",
    hiringManager: "Responsable de Contratación",
    signoff: "Atentamente,",
  },
};

/**
 * Role titles per language, keyed by angle id. Without these the CV headline
 * and summary stay English while the body is translated — the exact
 * half-translated result the fallback rule exists to prevent.
 */
export const CV_TITLES: Record<Lang, Record<string, string>> = {
  en: {},   // falls through to Angle.cvTitle
  pt: {
    iam: "Engenheiro de Identidade e Acesso (IAM)",
    devops: "Engenheiro de Plataforma / DevOps",
    devsecops: "Engenheiro de DevSecOps / Segurança",
    security: "Engenheiro de Segurança da Informação",
    compliance: "Especialista em Conformidade e Governança de Segurança",
    cloud: "Engenheiro de Infraestrutura em Nuvem",
    ai: "Engenheiro de Plataforma de IA / Infraestrutura de Agentes",
    observability: "Engenheiro de Observabilidade / Plataforma",
    fullstack: "Engenheiro Full Stack",
    automation: "Engenheiro de Automação e Integração",
    "ai-fullstack": "Engenheiro de Aplicações com IA",
    architecture: "Arquiteto de Soluções",
  },
  es: {
    iam: "Ingeniero de Identidad y Acceso (IAM)",
    devops: "Ingeniero de Plataforma / DevOps",
    devsecops: "Ingeniero de DevSecOps / Seguridad",
    security: "Ingeniero de Seguridad de la Información",
    compliance: "Especialista en Cumplimiento y Gobernanza de Seguridad",
    cloud: "Ingeniero de Infraestructura en la Nube",
    ai: "Ingeniero de Plataforma de IA / Infraestructura de Agentes",
    observability: "Ingeniero de Observabilidad / Plataforma",
    fullstack: "Ingeniero Full Stack",
    automation: "Ingeniero de Automatización e Integración",
    "ai-fullstack": "Ingeniero de Aplicaciones con IA",
    architecture: "Arquitecto de Soluciones",
  },
};

export const DEFAULT_TITLE: Record<Lang, string> = {
  en: "Infrastructure & Security Engineer",
  pt: "Engenheiro de Infraestrutura e Segurança",
  es: "Ingeniero de Infraestructura y Seguridad",
};

/**
 * Opening frame of the CV summary.
 *
 * `years` counts all professional experience; `recent` counts only the current
 * role. Cloud, security and automation started with the current role, so
 * stating "5+ years across cloud infrastructure" would stretch an operations
 * job into a domain it was not.
 */
export const SUMMARY_FRAME: Record<Lang, (role: string, years: number, recent: number) => string> = {
  en: (role, years, recent) =>
    recent > 0 && recent < years
      ? `${role} with ${years}+ years of professional experience, including ${recent}+ years in cloud infrastructure, security and automation.`
      : `${role} with ${years}+ years across cloud infrastructure, security and automation.`,
  pt: (role, years, recent) =>
    recent > 0 && recent < years
      ? `${role} com mais de ${years} anos de experiência profissional, dos quais mais de ${recent} em infraestrutura em nuvem, segurança e automação.`
      : `${role} com mais de ${years} anos de atuação em infraestrutura em nuvem, segurança e automação.`,
  es: (role, years, recent) =>
    recent > 0 && recent < years
      ? `${role} con más de ${years} años de experiencia profesional, de ellos más de ${recent} en infraestructura en la nube, seguridad y automatización.`
      : `${role} con más de ${years} años de experiencia en infraestructura en la nube, seguridad y automatización.`,
};

/** "A, B and C" in the document language. */
export function joinList(items: string[], lang: Lang): string {
  if (items.length <= 1) return items.join("");
  const and = { en: "and", pt: "e", es: "y" }[lang];
  return `${items.slice(0, -1).join(", ")} ${and} ${items.at(-1)}`;
}

/** Summary sentence naming the posting's technologies the candidate works in. */
export const SUMMARY_STACK: Record<Lang, (skills: string) => string> = {
  en: (s) => `Hands-on with ${s}.`,
  pt: (s) => `Experiência prática com ${s}.`,
  es: (s) => `Experiencia práctica con ${s}.`,
};

/** Provenance tag on a highlight, so a personal project never reads as employer work. */
export const INDEPENDENT_PROJECT: Record<Lang, string> = {
  en: "independent project",
  pt: "projeto independente",
  es: "proyecto independiente",
};

export const APPLYING_FOR: Record<Lang, (title: string) => string> = {
  en: (t) => ` Applying for ${t}.`,
  pt: (t) => ` Candidatura para a vaga de ${t}.`,
  es: (t) => ` Postulación para el puesto de ${t}.`,
};

/** Language names, rendered in the document's own language. */
export const LANGUAGE_NAMES: Record<Lang, Record<string, string>> = {
  en: { English: "English", Portuguese: "Portuguese", French: "French", Spanish: "Spanish" },
  pt: { English: "Inglês", Portuguese: "Português", French: "Francês", Spanish: "Espanhol" },
  es: { English: "Inglés", Portuguese: "Portugués", French: "Francés", Spanish: "Español" },
};

export const LEVEL_NAMES: Record<Lang, Record<string, string>> = {
  en: { Native: "Native", Intermediate: "Intermediate", C1: "C1" },
  pt: { Native: "Nativo", Intermediate: "Intermediário", C1: "C1" },
  es: { Native: "Nativo", Intermediate: "Intermedio", C1: "C1" },
};

/** Cover-letter sentence frames. `{company}` / `{role}` are substituted. */
export const LETTER: Record<Lang, {
  opening: string;
  /** Names the posting's technologies the candidate already works in. */
  stack: (skills: string) => string;
  /** Names the certifications related to the posting (only called when some are). */
  certifications: (names: string) => string;
  /** Introduces the evidence list. */
  evidenceIntro: string;
  timezone: (regions: string) => string;
  english: (level: string) => string;
  workAuthorization: string;
  closing: string;
}> = {
  en: {
    opening: "I am applying for the {role} role at {company}.",
    stack: (s) => `I work hands-on with ${s}, all of which this posting names.`,
    certifications: (c) => `I also hold certifications that bear on this role: ${c}.`,
    evidenceIntro: "The work most relevant to this role:",
    timezone: (r) => `I work daily with distributed teams across ${r}, so cross-timezone collaboration is routine rather than new`,
    english: (l) => `my English is ${l} certified`,
    workAuthorization: "I hold full work authorization for this location, so no visa sponsorship is needed.",
    closing: "I would welcome the chance to talk about how this maps onto what {company} needs. My work is public at {github} and {website}.",
  },
  pt: {
    opening: "Venho me candidatar à vaga de {role} na {company}.",
    stack: (s) => `Trabalho na prática com ${s}, tecnologias citadas nesta vaga.`,
    certifications: (c) => `Tenho também certificações ligadas a esta vaga: ${c}.`,
    evidenceIntro: "Os trabalhos mais relevantes para esta vaga:",
    timezone: (r) => `Trabalho diariamente com equipes distribuídas entre ${r}, portanto a colaboração entre fusos horários já faz parte da minha rotina`,
    english: (l) => `meu inglês é ${l} certificado`,
    workAuthorization: "Tenho autorização plena de trabalho para esta localidade, sem necessidade de patrocínio de visto.",
    closing: "Gostaria muito de conversar sobre como isso se conecta ao que a {company} precisa. Meu trabalho está público em {github} e {website}.",
  },
  es: {
    opening: "Me postulo para el puesto de {role} en {company}.",
    stack: (s) => `Trabajo de forma práctica con ${s}, tecnologías que menciona esta vacante.`,
    certifications: (c) => `También tengo certificaciones relacionadas con este puesto: ${c}.`,
    evidenceIntro: "El trabajo más relevante para este puesto:",
    timezone: (r) => `Trabajo a diario con equipos distribuidos entre ${r}, de modo que la colaboración entre husos horarios ya es parte de mi rutina`,
    english: (l) => `mi inglés es ${l} certificado`,
    workAuthorization: "Tengo autorización plena de trabajo para esta ubicación, sin necesidad de patrocinio de visado.",
    closing: "Me encantaría conversar sobre cómo esto se conecta con lo que {company} necesita. Mi trabajo está público en {github} y {website}.",
  },
};

/**
 * Technology names a translator must leave alone. It is a general vocabulary of
 * product, protocol and standard names, not one candidate's stack: a name it
 * misses is simply not checked, and no name here is ever added to a document.
 */
const TECHNOLOGY_TOKENS =
  /\b(?:ISO 27001|SOC 2|NIST|GDPR|LGPD|IAM|RBAC|SSO|SAML|OAuth|OIDC|MFA|SIEM|SOAR|EDR|MCP|LLM|API|REST|GraphQL|gRPC|CI\/CD|SLO|SLA|Entra ID|Active Directory|Okta|SailPoint|CyberArk|Keycloak|Vault|Terraform|Ansible|Puppet|Chef|Pulumi|Kubernetes|Docker|OpenShift|Helm|Istio|Nginx|Apache|Linux|Windows|macOS|Python|Java|JavaScript|TypeScript|Go|Golang|Rust|Ruby|PHP|C#|\.NET|Node\.js|React|Vue|Angular|Svelte|Next\.js|Astro|Django|Flask|FastAPI|Rails|Spring|Express|PostgreSQL|MySQL|MariaDB|SQLite|MongoDB|Redis|Elasticsearch|OpenSearch|Kafka|RabbitMQ|Spark|Airflow|dbt|Snowflake|BigQuery|AWS|Azure|GCP|OCI|Oracle|Cloudflare|Vercel|Supabase|Firebase|Datadog|Prometheus|Grafana|Splunk|New Relic|Sentry|Jenkins|GitHub Actions|GitLab CI|CircleCI|ArgoCD|Jira|Playwright|Cypress|Vitest|Jest|Vite|Webpack|Turborepo|Tailwind|Power BI|Tableau|Looker|VMware|Hyper-V|Proxmox)\b/gi;

/**
 * Translation integrity: numbers and technology tokens must survive unchanged.
 *
 * This is what keeps a localized document as trustworthy as the English one it
 * came from — a translation that quietly turns "250 endpoints" into "250.000" or
 * drops "ISO 27001" has fabricated, even if every sentence reads well.
 */
export function checkTranslationIntegrity(
  source: string,
  translated: string,
): { ok: boolean; missing: string[] } {
  const tokens = (s: string) => {
    const nums = [...s.matchAll(/\b\d[\d.,]*\+?\b/g)].map((m) => m[0].replace(/[.,]$/, ""));
    const techs = [...s.matchAll(TECHNOLOGY_TOKENS)].map((m) => m[0]);
    return new Set([...nums, ...techs.map((t) => t.toLowerCase())]);
  };

  const src = tokens(source);
  const dst = tokens(translated);
  const missing = [...src].filter((t) => !dst.has(t));
  return { ok: missing.length === 0, missing };
}

/**
 * Metric labels, translated.
 *
 * The metric strings live in the corpus in English ("250 endpoints"), and they are
 * rendered in bold at the very top of the CV. Leaving them untranslated puts an
 * English fragment in the most-read line of a Portuguese document.
 */
const METRIC_WORDS: Record<Exclude<Lang, "en">, [RegExp, string][]> = {
  pt: [
    [/\busers?\b/gi, "usuários"], [/\bendpoints?\b/gi, "endpoints"],
    [/\bcertifications?\b/gi, "certificações"], [/\bdevelopers?\b/gi, "desenvolvedores"],
    [/\bplatform integrations?\b/gi, "integrações de plataforma"],
    [/\bcloud providers?\b/gi, "provedores de nuvem"],
    [/\blive products?\b/gi, "produtos no ar"], [/\bproducts?\b/gi, "produtos"],
    [/\bcommits in\b/gi, "commits em"], [/\bSQL files\b/gi, "arquivos SQL"],
    [/\bTS\/TSX files\b/gi, "arquivos TS/TSX"],
    [/\bIaC module domains\b/gi, "domínios de módulos IaC"],
    [/\bCI\/CD providers?\b/gi, "provedores de CI/CD"],
    [/\bsystem classes unified\b/gi, "classes de sistema unificadas"],
    [/\bregions?\b/gi, "regiões"], [/\bthousands of USD saved\b/gi, "milhares de dólares economizados"],
    [/\bfull debt recovery\b/gi, "recuperação integral da dívida"],
    [/\bCIO-level\b/gi, "nível CIO"],
  ],
  es: [
    [/\busers?\b/gi, "usuarios"], [/\bendpoints?\b/gi, "endpoints"],
    [/\bcertifications?\b/gi, "certificaciones"], [/\bdevelopers?\b/gi, "desarrolladores"],
    [/\bplatform integrations?\b/gi, "integraciones de plataforma"],
    [/\bcloud providers?\b/gi, "proveedores de nube"],
    [/\blive products?\b/gi, "productos en producción"], [/\bproducts?\b/gi, "productos"],
    [/\bcommits in\b/gi, "commits en"], [/\bSQL files\b/gi, "archivos SQL"],
    [/\bTS\/TSX files\b/gi, "archivos TS/TSX"],
    [/\bIaC module domains\b/gi, "dominios de módulos IaC"],
    [/\bCI\/CD providers?\b/gi, "proveedores de CI/CD"],
    [/\bsystem classes unified\b/gi, "clases de sistema unificadas"],
    [/\bregions?\b/gi, "regiones"], [/\bthousands of USD saved\b/gi, "miles de dólares ahorrados"],
    [/\bfull debt recovery\b/gi, "recuperación total de la deuda"],
    [/\bCIO-level\b/gi, "nivel CIO"],
  ],
};

/** Translate a metric label. Numbers and symbols are untouched. */
export function localizeMetric(metric: string, lang: Lang): string {
  if (lang === "en") return metric;
  let out = metric;
  for (const [re, to] of METRIC_WORDS[lang]) out = out.replace(re, to);
  return out;
}
