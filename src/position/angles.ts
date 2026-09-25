/**
 * Positioning angles.
 *
 * An angle is a runtime argument, never stored config: the candidate says "IAM" or
 * "devops" or "AI infrastructure" and the corpus is re-projected toward it.
 * Each angle weights domains by relevance; the projector combines that with
 * where the domain sits in a claim's own `domains` list (centrality).
 *
 * `variantKeys` is the lookup order for a claim's angle-specific rewording.
 */

export interface Angle {
  id: string;
  label: string;
  /** Title rendered at the top of the CV for this angle. Never "Junior". */
  cvTitle: string;
  /** domain -> weight (1.0 = the angle IS this domain). */
  domains: Record<string, number>;
  variantKeys: string[];
  /** Free-text the operator might type, lowercased. */
  aliases: string[];
  /** Title families to match against postings for this angle. */
  titleHints: string[];
}

export const ANGLES: Angle[] = [
  {
    id: "iam",
    label: "Identity & Access Management",
    cvTitle: "Identity & Access Management Engineer",
    domains: { iam: 1.0, security: 0.5, governance: 0.4, compliance: 0.3, cloud: 0.3 },
    variantKeys: ["iam", "security", "compliance"],
    aliases: ["iam", "identity", "access management", "identity and access", "entra", "okta", "idp", "iga"],
    titleHints: ["iam", "identity", "access", "directory", "iga"],
  },
  {
    id: "devops",
    label: "DevOps / Platform Engineering",
    cvTitle: "Platform / DevOps Engineer",
    domains: { devops: 1.0, automation: 0.6, infrastructure: 0.5, cloud: 0.5, platform: 0.5, cicd: 0.4, migration: 0.3 },
    variantKeys: ["devops", "platform", "cloud", "automation"],
    aliases: ["devops", "dev ops", "platform", "platform engineering", "infrastructure", "infra", "sre", "site reliability"],
    titleHints: ["devops", "platform", "infrastructure", "sre", "reliability", "cloud engineer"],
  },
  {
    id: "devsecops",
    label: "DevSecOps / Security Engineering",
    cvTitle: "DevSecOps / Security Engineer",
    domains: { devsecops: 1.0, security: 0.9, devops: 0.6, automation: 0.6, compliance: 0.5, iam: 0.4, platform: 0.4 },
    variantKeys: ["security", "devops", "automation", "platform"],
    aliases: ["devsecops", "security engineering", "security engineer", "product security", "appsec", "cloud security"],
    titleHints: ["security engineer", "devsecops", "cloud security", "security automation"],
  },
  {
    id: "security",
    label: "Information Security / Blue Team",
    cvTitle: "Security Engineer",
    domains: { security: 1.0, blueteam: 0.8, "incident-response": 0.7, compliance: 0.5, endpoint: 0.5, forensics: 0.5, iam: 0.4 },
    variantKeys: ["security", "blueteam", "compliance"],
    aliases: ["security", "infosec", "blue team", "blueteam", "soc", "incident response", "threat", "detection"],
    titleHints: ["security analyst", "soc", "incident", "threat", "blue team", "security operations"],
  },
  {
    id: "compliance",
    label: "Security Compliance & Governance",
    cvTitle: "Security Compliance & Governance Specialist",
    domains: { compliance: 1.0, governance: 0.8, security: 0.6, documentation: 0.4, iam: 0.4, architecture: 0.3 },
    variantKeys: ["compliance", "security", "governance"],
    aliases: ["compliance", "grc", "governance", "iso 27001", "iso27001", "audit", "risk"],
    titleHints: ["compliance", "grc", "risk", "audit", "governance"],
  },
  {
    id: "cloud",
    label: "Cloud Infrastructure Engineering",
    cvTitle: "Cloud Infrastructure Engineer",
    domains: { cloud: 1.0, multicloud: 0.8, infrastructure: 0.6, devops: 0.6, migration: 0.5, architecture: 0.5, iam: 0.4 },
    variantKeys: ["cloud", "devops", "platform"],
    aliases: ["cloud", "oci", "aws", "azure", "multicloud", "cloud infrastructure", "cloud architect"],
    titleHints: ["cloud engineer", "cloud architect", "infrastructure engineer", "cloud operations"],
  },
  {
    id: "ai",
    label: "AI Platform / Agent Infrastructure",
    cvTitle: "AI Platform / Agent Infrastructure Engineer",
    domains: { ai: 1.0, observability: 0.5, platform: 0.4, automation: 0.3, cloud: 0.3, integration: 0.3 },
    variantKeys: ["ai", "observability", "platform"],
    aliases: ["ai", "ai infra", "ai infrastructure", "ai platform", "agent", "agents", "mcp", "llm", "ml infra", "ai product"],
    titleHints: ["ai engineer", "ai platform", "ml infrastructure", "agent", "llm", "ai product"],
  },
  {
    id: "observability",
    label: "Observability / Monitoring",
    cvTitle: "Observability / Platform Engineer",
    domains: { observability: 1.0, monitoring: 0.9, platform: 0.5, cloud: 0.4, automation: 0.3, data: 0.3 },
    variantKeys: ["observability", "platform"],
    aliases: ["observability", "monitoring", "telemetry", "datadog", "prometheus"],
    titleHints: ["observability", "monitoring", "telemetry", "reliability"],
  },
  {
    id: "fullstack",
    label: "Full Stack Engineering",
    cvTitle: "Full Stack Engineer",
    domains: { fullstack: 1.0, platform: 0.5, integration: 0.4, automation: 0.4, data: 0.3 },
    variantKeys: ["fullstack", "platform"],
    aliases: ["fullstack", "full stack", "full-stack", "frontend", "backend", "web developer", "software engineer"],
    titleHints: ["full stack", "software engineer", "backend", "frontend", "developer"],
  },
  {
    id: "automation",
    label: "Automation & Integration Engineering",
    cvTitle: "Automation & Integration Engineer",
    domains: { automation: 1.0, integration: 0.8, serverless: 0.5, platform: 0.4, operations: 0.4, devops: 0.4 },
    variantKeys: ["automation", "devops", "platform"],
    aliases: ["automation", "integration", "scripting", "tooling", "internal tools"],
    titleHints: ["automation", "integration", "tooling", "internal tools"],
  },
  {
    id: "ai-fullstack",
    label: "AI Application Engineering",
    cvTitle: "AI Application Engineer",
    // For candidates who ship AI-integrated products end to end, rather than
    // doing modelling or pure frontend work.
    domains: { ai: 1.0, fullstack: 0.9, product: 0.6, architecture: 0.5, platform: 0.4, agents: 0.8, integration: 0.4 },
    variantKeys: ["ai", "fullstack", "architecture", "platform"],
    aliases: [
      "ai fullstack", "ai full stack", "ai full-stack", "ai application",
      "ai app", "ai engineer", "ai product engineer", "applied ai",
      "genai", "gen ai", "ai software",
    ],
    titleHints: [
      "ai engineer", "ai application", "applied ai", "ai product",
      "ai software engineer", "full stack ai", "genai",
    ],
  },
  {
    id: "architecture",
    label: "Solutions & Product Architecture",
    cvTitle: "Solutions Architect",
    domains: { architecture: 1.0, platform: 0.7, cloud: 0.6, fullstack: 0.5, integration: 0.5, multicloud: 0.5, migration: 0.4 },
    variantKeys: ["architecture", "platform", "cloud", "fullstack"],
    aliases: [
      "architecture", "architect", "solutions architect", "solution architect",
      "software architect", "product architecture", "technical architect",
    ],
    titleHints: [
      "architect", "solutions architect", "software architect",
      "technical architect", "principal engineer",
    ],
  },
];

const BY_ID = new Map(ANGLES.map((a) => [a.id, a]));

/**
 * Resolve free-text input to an angle. Returns null when nothing matches —
 * callers fall back to global strength ordering rather than guessing (ISC-10).
 */
export function resolveAngle(input: string | null | undefined): Angle | null {
  if (!input?.trim()) return null;
  const q = input.trim().toLowerCase();

  const exact = BY_ID.get(q);
  if (exact) return exact;

  // Longest alias wins, so "cloud security" beats "cloud" and "security".
  let best: { angle: Angle; len: number } | null = null;
  for (const angle of ANGLES) {
    for (const alias of angle.aliases) {
      if (q === alias || q.includes(alias)) {
        if (!best || alias.length > best.len) best = { angle, len: alias.length };
      }
    }
  }
  return best?.angle ?? null;
}

export function listAngles(): string[] {
  return ANGLES.map((a) => `${a.id} — ${a.label}`);
}
