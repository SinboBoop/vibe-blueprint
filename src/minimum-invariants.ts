import {
  MINIMUM_INVARIANTS_BY_FAMILY,
  type MinimumInvariantFamilyId,
  type MinimumInvariantId,
} from "./invariant-ids.js";
import {
  getArchitecturePattern,
  getInvariantFamily,
  loadArchitecturePatternRegistry,
  type ArchitecturePatternRegistry,
} from "./pattern-registry.js";
import type {
  CandidateRoute,
  FoundationFact,
  HardConstraint,
  ModelAnalysis,
} from "./schemas.js";

export interface MinimumInvariantContext {
  readonly requiredFamilies?: ReadonlySet<MinimumInvariantFamilyId>;
  readonly registry?: ArchitecturePatternRegistry;
}

export interface RouteMinimumInvariantResult {
  readonly route_id: string;
  readonly required_invariant_ids: readonly MinimumInvariantId[];
  readonly satisfied_invariant_ids: readonly MinimumInvariantId[];
  readonly missing_invariant_ids: readonly MinimumInvariantId[];
  readonly conflicts: readonly string[];
  readonly eligible: boolean;
}

const POSITIVE_TEXT = /(?:\b(?:authoritative|production|live|real|multi[- ]?user|tenant|multi[- ]?(?:org|organization)|sensitive|personal data|pii|phi)\b|权威|生产|正式|真实数据|真实业务数据|正式业务数据|多用户|多租户|多组织|敏感数据|个人信息)/iu;
const PRODUCTION_KEY = /(?:authoritative|production|live_records|real_records|real_business_data|production_data|multi_user_workflow)/iu;
const OFFLINE_REQUIRED_KEY = /(?:must_continue_offline|offline_required|work_during_outage|outage_continuity)/iu;
const OFFLINE_CONTINUITY_KEY = /offline_continuity/iu;
const MULTI_ORG_KEY = /(?:multi[_-]?(?:org|organization|tenant)|multitenan|tenant_count|organization_count)/iu;
const PAYMENT_KEY = /(?:money_movement|real_payments?|payment_control|funds_control|transfer_authority)/iu;
const SENSITIVE_KEY = /(?:sensitive|personal_data|pii|phi|medical_data|financial_data)/iu;
const CALLBACK_TEXT = /(?:\b(?:callbacks?|webhooks?|provider events?)\b|回调|网络钩子|提供商事件)/iu;
const PAYMENT_CONTEXT_TEXT = /(?:\b(?:payments?|payment provider|payment processor|funds?|money|charges?|refunds?|checkout)\b|支付|付款|支付服务商|支付提供商|资金|款项|扣款|退款)/iu;
const CALLBACK_AUTHORITY_TEXT = /(?:\b(?:authoritative|authenticated|authenticity|verified|verification|signed|signature|trusted|source of truth)\b|权威|可信|验证|验签|签名|真实状态)/iu;
const CALLBACK_CLAUSE_BOUNDARY = /(?:[.!?;,。！？；，]|\b(?:but|however|instead|yet)\b|但是|但|而是|却|\b(?:and|while|whereas)\s+(?=(?:(?:the\s+)?(?:service|system|app(?:lication)?|product)|it)\s+(?:receives|accepts|consumes|processes|handles|verifies|trusts|uses|listens)\b|(?:receives|accepts|consumes|processes|handles|verifies|trusts|uses|listens)\b)|(?:并|且|同时|也)(?=(?:会|将|仍|还|可以|需要|必须)?(?:接收|接受|处理|消费|验证|验签|信任|使用)))/iu;
const EXPLICIT_SENSITIVE_FACT_TEXT = /(?:\b(?:sensitive (?:personal |business )?data|personal (?:data|information)|personally identifiable information|pii|protected health information|phi|medical records?|health records?|patient records?|biometric data|bank account (?:data|details|numbers?)|tax identification (?:data|numbers?))\b|敏感数据|个人信息|个人数据|医疗记录|健康记录|患者记录|生物识别数据|银行账户(?:信息|数据)|税务识别号)/giu;

function normalizedText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return "";
  }
  return String(value).normalize("NFKC").toLocaleLowerCase("en-US");
}

const NEGATIVE_VALUE = /^(?:false|no|none|not(?:\s+applicable)?|n\/a|disabled|excluded?|does not|do not|never|without|否|不是|不适用|不|无|没有|未启用|排除)(?:\b|$)/iu;

function explicitlyNegativeValue(fact: FoundationFact): boolean {
  if (fact.value === false) return true;
  if (typeof fact.value === "number") return fact.value <= 0;
  if (typeof fact.value !== "string") return false;
  const value = normalizedText(fact.value).trim();
  return NEGATIVE_VALUE.test(value) &&
    !/(?:\b(?:but|however|instead|yet)\b|但是|但|而是|却)/iu.test(value);
}

function factText(fact: FoundationFact): string {
  return [fact.key, fact.label, fact.source_excerpt ?? "", normalizedText(fact.value)]
    .join(" ")
    .normalize("NFKC")
    .replace(/[_-]+/gu, " ");
}

function affirmativeValue(fact: FoundationFact): boolean {
  if (fact.value === true) return true;
  if (typeof fact.value === "number") return fact.value > 0;
  if (typeof fact.value !== "string") return false;
  const value = normalizedText(fact.value).trim();
  return value.length > 0 && !explicitlyNegativeValue(fact);
}

function hasUnnegatedAuthoritativePaymentCallback(text: string): boolean {
  return text
    .split(CALLBACK_CLAUSE_BOUNDARY)
    .some((clause) =>
      CALLBACK_TEXT.test(clause) &&
      PAYMENT_CONTEXT_TEXT.test(clause) &&
      CALLBACK_AUTHORITY_TEXT.test(clause) &&
      !/(?:\b(?:no|not|never|without|does not|do not|will not|must not)\b|(?:不|无|没有|不会|不接收|不处理|无需|禁止))/iu.test(clause),
    );
}

function factRequiresAuthoritativePaymentCallback(fact: FoundationFact): boolean {
  if (!affirmativeValue(fact)) return false;
  return hasUnnegatedAuthoritativePaymentCallback(factText(fact));
}

function factRequiresProduction(fact: FoundationFact): boolean {
  // An authoritative callback is an input from a payment authority, not proof
  // that this route itself owns general production records. Payment safeguards
  // are computed independently below.
  const text = factText(fact);
  if (!affirmativeValue(fact)) return false;
  const explicitProduction = POSITIVE_TEXT.test(text) &&
    /(?:authoritative (?:production )?(?:data|records?|state)|production (?:business )?(?:data|records?|state)|live (?:business )?(?:data|records?|state)|real (?:business )?(?:data|records?|state)|multi[- ]?user|权威.*(?:数据|记录|状态)|生产.*(?:数据|记录|状态)|正式.*(?:数据|记录)|真实业务数据|多用户)/iu.test(text);
  if (explicitProduction) return true;
  if (CALLBACK_TEXT.test(text) && PAYMENT_CONTEXT_TEXT.test(text)) return false;
  return PRODUCTION_KEY.test(fact.key);
}

function factRequiresMultiOrganization(fact: FoundationFact): boolean {
  if (!MULTI_ORG_KEY.test(fact.key) || !affirmativeValue(fact)) return false;
  if (typeof fact.value === "number") return fact.value > 1;
  if (typeof fact.value !== "string") return true;
  const value = normalizedText(fact.value).trim();
  if (/^(?:1|one|single(?:\s+(?:org|organization|tenant))?|一(?:个)?(?:组织|租户)?|单一组织|单租户)$/iu.test(value)) {
    return false;
  }
  return true;
}

function factRequiresOffline(fact: FoundationFact): boolean {
  if (fact.constraint_level !== "hard" && fact.adjustable !== false) return false;
  if (OFFLINE_REQUIRED_KEY.test(fact.key)) return affirmativeValue(fact);
  if (!OFFLINE_CONTINUITY_KEY.test(fact.key)) return false;

  // v1's established fact asks whether work may pause. `false` therefore means
  // that continuity through an outage is mandatory.
  if (typeof fact.value === "boolean") return !fact.value;
  return /(?:must continue|cannot (?:pause|stop)|不停工|必须继续|不能停)/iu.test(factText(fact));
}

function factRequiresSensitiveData(fact: FoundationFact): boolean {
  if (
    explicitlyNegativeValue(fact) ||
    typeof fact.value === "string" && normalizedText(fact.value).trim().length === 0
  ) {
    return false;
  }
  const text = factText(fact);
  for (const match of text.matchAll(EXPLICIT_SENSITIVE_FACT_TEXT)) {
    const start = match.index;
    const rawPrefix = text.slice(Math.max(0, start - 96), start);
    const boundaryMatches = [...rawPrefix.matchAll(/(?:[.!?;,。！？；，]|\b(?:but|however|instead|yet)\b|但是|但|而是|却)/giu)];
    const lastBoundary = boundaryMatches.at(-1);
    const prefix = lastBoundary === undefined
      ? rawPrefix
      : rawPrefix.slice(lastBoundary.index + lastBoundary[0].length);
    const negated = /(?:\b(?:no|not|none|without|exclude|excludes|excluded|does not|do not|will not|never)\b[^.!?;,]{0,64}(?:(?:or|and)\s*)?|(?:不|无|没有|不含|不包括|排除|不会|不处理|不存储)[^。！？；，,]{0,40}(?:、|或|和|以及|也)?\s*)$/iu.test(prefix);
    if (!negated) return true;
  }
  return false;
}

function constraintText(constraints: readonly HardConstraint[]): string {
  return constraints.map((constraint) => constraint.description).join(" \n ");
}

function hasUnnegatedConstraintSignal(text: string, signal: RegExp): boolean {
  return text
    .split(/(?:[.!?;。！？；]|\n)/u)
    .some((clause) =>
      signal.test(clause) &&
      !/(?:\b(?:no|not|never|without|does not|do not|will not|must not|cannot|can't|exclude|excluded)\b|(?:不|无|没有|不会|不得|禁止|排除|不处理|不存储|不支持))/iu.test(clause),
    );
}

function projectRequiredFamilies(analysis: ModelAnalysis): Set<MinimumInvariantFamilyId> {
  const result = new Set<MinimumInvariantFamilyId>();
  const constraints = constraintText(analysis.hard_constraints);

  if (
    analysis.facts.some(factRequiresProduction) ||
    hasUnnegatedConstraintSignal(
      constraints,
      /(?:authoritative (?:production )?(?:records?|state)|production (?:business )?(?:records?|state|data)|real business data|multi[- ]user workflow|权威.*记录|生产.*(?:记录|数据)|正式.*数据|真实业务数据|多用户.*流程)/iu,
    )
  ) {
    result.add("production");
  }
  if (
    analysis.facts.some(factRequiresOffline) ||
    hasUnnegatedConstraintSignal(
      constraints,
      /(?:must continue.*(?:offline|outage)|continue.*(?:network|internet).*outage|断网.*(?:继续|不停工)|离线.*必须)/iu,
    )
  ) {
    result.add("offline");
  }
  if (
    analysis.facts.some(factRequiresMultiOrganization) ||
    hasUnnegatedConstraintSignal(
      constraints,
      /(?:multi[- ]?(?:organization|tenant)|tenant isolation|多组织|多租户|租户隔离)/iu,
    )
  ) {
    result.add("multi_org");
  }
  if (
    analysis.facts.some((fact) =>
      PAYMENT_KEY.test(fact.key) && affirmativeValue(fact) ||
      factRequiresAuthoritativePaymentCallback(fact)
    ) ||
    hasUnnegatedConstraintSignal(
      constraints,
      /(?:initiat|authoriz|control|hold).*(?:payment|fund|money|transfer)|真实支付|发起.*(?:付款|转账)|控制.*资金/iu,
    ) ||
    hasUnnegatedAuthoritativePaymentCallback(constraints)
  ) {
    result.add("payments");
  }
  if (
    analysis.facts.some((fact) =>
      SENSITIVE_KEY.test(fact.key) && affirmativeValue(fact) || factRequiresSensitiveData(fact)
    ) ||
    hasUnnegatedConstraintSignal(
      constraints,
      /(?:sensitive (?:personal |business )?data|pii|phi|敏感数据|个人信息)/iu,
    )
  ) {
    result.add("sensitive");
  }
  return result;
}

function routeRequiredFamilies(
  route: CandidateRoute,
  registry: ArchitecturePatternRegistry,
): Set<MinimumInvariantFamilyId> {
  const result = new Set<MinimumInvariantFamilyId>();
  if (route.capability_profile.supports_offline_continuity) result.add("offline");
  if (route.capability_profile.supports_multi_organization) result.add("multi_org");
  if (route.capability_profile.handles_real_payments) result.add("payments");
  if (route.capability_profile.protects_sensitive_data) result.add("sensitive");

  const pattern = getArchitecturePattern(registry, route.architecture.pattern);
  for (const invariantId of pattern.minimum_invariant_ids) {
    const family = invariantId.split(".", 1)[0];
    if (
      family === "production" ||
      family === "offline" ||
      family === "multi_org" ||
      family === "payments" ||
      family === "sensitive"
    ) {
      result.add(family);
    }
  }
  return result;
}

function sortedInvariantIds(
  ids: Iterable<MinimumInvariantId>,
): readonly MinimumInvariantId[] {
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

export function computeRequiredInvariantFamilies(
  analysis: ModelAnalysis,
  route: CandidateRoute,
  context: MinimumInvariantContext = {},
): ReadonlySet<MinimumInvariantFamilyId> {
  const registry = context.registry ?? loadArchitecturePatternRegistry();
  return new Set([
    ...projectRequiredFamilies(analysis),
    ...routeRequiredFamilies(route, registry),
    ...(context.requiredFamilies ?? []),
  ]);
}

export function validateRouteMinimumInvariants(
  analysis: ModelAnalysis,
  route: CandidateRoute,
  context: MinimumInvariantContext = {},
): RouteMinimumInvariantResult {
  const registry = context.registry ?? loadArchitecturePatternRegistry();
  const requiredFamilies = computeRequiredInvariantFamilies(analysis, route, {
    ...context,
    registry,
  });
  const requiredIds = sortedInvariantIds(
    [...requiredFamilies].flatMap((family) => MINIMUM_INVARIANTS_BY_FAMILY[family]),
  );
  const satisfiedIds = sortedInvariantIds(route.satisfied_invariant_ids);
  const satisfiedSet = new Set(satisfiedIds);
  const missingIds = requiredIds.filter((id) => !satisfiedSet.has(id));
  const conflicts: string[] = [];

  for (const familyId of [...requiredFamilies].sort()) {
    const family = getInvariantFamily(registry, familyId);
    if (
      family.required_pattern_ids.length > 0 &&
      !family.required_pattern_ids.includes(route.architecture.pattern)
    ) {
      conflicts.push(
        `${familyId} requires pattern ${family.required_pattern_ids.join(" or ")}; route uses ${route.architecture.pattern}.`,
      );
    }
    if (family.incompatible_pattern_ids.includes(route.architecture.pattern)) {
      conflicts.push(
        `${route.architecture.pattern} is incompatible with required ${familyId} capability.`,
      );
    }
  }

  return {
    route_id: route.id,
    required_invariant_ids: requiredIds,
    satisfied_invariant_ids: satisfiedIds,
    missing_invariant_ids: missingIds,
    conflicts: conflicts.sort((left, right) => left.localeCompare(right)),
    eligible: missingIds.length === 0 && conflicts.length === 0,
  };
}

export function minimumInvariantIdsForFamilies(
  families: Iterable<MinimumInvariantFamilyId>,
): readonly MinimumInvariantId[] {
  return sortedInvariantIds(
    [...families].flatMap((family) => MINIMUM_INVARIANTS_BY_FAMILY[family]),
  );
}
