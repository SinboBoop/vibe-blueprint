import type { FoundationState } from "./state.js";

const CHANGE_DOMAINS = Object.freeze({
  payment: /(?:\b(?:payment|billing|subscription|checkout|invoice|charge|refund|money|paid|financial activity|expense|reimbursement)\b|支付|付款|账单|订阅|退款|收费|财务活动|报销)/iu,
  multitenancy: /(?:\b(?:multi[ -]?tenant|tenant|organization|workspace|different companies|client accounts?)\b|多租户|租户|组织|不同公司|工作空间)/iu,
  offline: /(?:\b(?:offline|outage|disconnected|without (?:a )?(?:network|connection)|sync|field staff)\b|离线|断网|无网络|同步|外勤)/iu,
  sensitive_data: /(?:\b(?:sensitive|medical|health|financial|children|child data|ssn|passport|biometric|regulated|personal data)\b|敏感数据|医疗|健康|儿童数据|护照|生物识别|个人数据|个人信息)/iu,
  production_data: /(?:\b(?:authoritative (?:production |business )?records?|production (?:data|records?)|real (?:business )?(?:data|records?)|live (?:business )?(?:data|records?)|demo (?:data|records?))\b|正式(?:业务)?数据|真实(?:业务)?数据|生产数据|权威(?:生产|业务)?记录|正式业务记录|真实业务记录|演示数据)/iu,
} as const);

export type AssessmentCapability = keyof typeof CHANGE_DOMAINS | "general_foundation";

export interface ChangeAssessmentContext {
  readonly affectedCapabilities: readonly AssessmentCapability[];
  readonly analysisRequest: string;
}

function serializedFactText(value: unknown): string {
  if (value === null || typeof value !== "object") return "";
  const candidate = value as { readonly key?: unknown; readonly label?: unknown };
  return [candidate.key, candidate.label]
    .filter((entry): entry is string => typeof entry === "string")
    .join(" ")
    .normalize("NFKC")
    .replace(/[_-]+/gu, " ");
}

/**
 * Decide whether a model-authored fact belongs to the explicitly affected
 * reassessment scope. Unknown fact namespaces fail closed unless the change is
 * a general-foundation reassessment.
 */
export function factBelongsToAffectedCapabilities(
  fact: unknown,
  affectedCapabilities: readonly string[],
): boolean {
  if (affectedCapabilities.includes("general_foundation")) return true;
  const text = serializedFactText(fact);
  return affectedCapabilities.some((capability) => {
    const pattern = (CHANGE_DOMAINS as Partial<Record<string, RegExp>>)[capability];
    return pattern !== undefined && pattern.test(text);
  });
}

export function filterFactsForAffectedCapabilities(
  facts: readonly unknown[],
  affectedCapabilities: readonly string[],
): readonly unknown[] {
  return facts.filter((fact) =>
    factBelongsToAffectedCapabilities(fact, affectedCapabilities),
  );
}

export function identifyAffectedCapabilities(requirement: string): readonly AssessmentCapability[] {
  const affected = Object.entries(CHANGE_DOMAINS)
    .filter(([, pattern]) => pattern.test(requirement))
    .map(([name]) => name as keyof typeof CHANGE_DOMAINS);
  return affected.length > 0 ? affected : ["general_foundation"];
}

export function buildChangeAssessment(
  foundation: FoundationState,
  newRequirement: string,
): ChangeAssessmentContext {
  const affectedCapabilities = identifyAffectedCapabilities(newRequirement);
  // The structured committed Foundation is sent separately through
  // ModelAnalysisRequest.foundationContext. Keeping it out of request avoids
  // duplicate, differently-shaped copies of the same authority in one prompt.
  void foundation;
  return {
    affectedCapabilities,
    analysisRequest: newRequirement.trim(),
  };
}

export const RELEASE_REVIEW_QUESTIONS = Object.freeze([
  "Will this release start taking real money?",
  "Will people from different companies start using it?",
  "Does it add sensitive or regulated information?",
  "Must work continue while the network is unavailable?",
  "Does it move from demo data to real production records?",
]);
