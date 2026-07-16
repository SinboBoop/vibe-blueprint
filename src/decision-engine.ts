import { randomUUID } from "node:crypto";

import {
  ActivityClassificationSchema,
  type ActivityClassification,
} from "./activity-risk.js";
import type { MinimumInvariantFamilyId } from "./invariant-ids.js";
import {
  validateRouteMinimumInvariants,
  type RouteMinimumInvariantResult,
} from "./minimum-invariants.js";
import {
  DecisionResultSchema,
  ModelAnalysisSchema,
  PresentedRouteSchema,
  type CandidateRoute,
  type DecisionResult,
  type FoundationFact,
  type ModelAnalysis,
  type PresentedRoute,
  type RiskState,
} from "./schemas.js";

const SCORE_KEYS = [
  "delivery_speed",
  "user_value",
  "reliability",
  "cost_efficiency",
  "operational_simplicity",
  "reversibility",
  "future_fit",
] as const;

// Match complete ASCII technology tokens after normalization. A bare substring
// check would turn ordinary business words such as "restaurant", "platform",
// or "form" into REST/ORM choices and suppress a valid reality question.
const TECHNICAL_CHOICE_KEYS = /(?<![a-z0-9])(?:api style|angular|database|framework|graphql|hosting|language|nosql|orm|react|rest(?:ful)?|sql|svelte|vue)(?![a-z0-9])/iu;

const TECHNICAL_FORK_MARKERS = Object.freeze({
  framework: /\b(?:angular|application framework|backend framework|frontend framework|framework|next ?js|nuxt|react|svelte|vue|web framework)\b/iu,
  database: /\b(?:database|data store|datastore|dbms|dynamodb|mariadb|mongodb|mysql|nosql|postgres|postgresql|relational store|sql database|sqlite)\b/iu,
  orm: /\b(?:drizzle|object relational mapper|orm|prisma|sequelize|typeorm)\b/iu,
  api_style: /\b(?:api style|graphql|grpc|rest|restful|rpc|trpc)\b/iu,
  hosting: /\b(?:amazon web services|aws|azure|cloud provider|cloudflare|deployment platform|gcp|google cloud|hosting|netlify|on premises|on prem|self hosted|serverless|vercel)\b/iu,
  mandatory_control: /\b(?:access control|audit logs?|auditability|authentication|authorization|backups?|baseline controls?|callback authenticity|data protection|deletion handling|encryption|failure recovery|idempoten\w*|input validation|logging|mandatory controls?|monitoring|permission checks?|reconciliation|retention handling|retry handling|security baseline|signature verification|tenant isolation|testing|tests?)\b/iu,
});

type TechnicalForkCategory = keyof typeof TECHNICAL_FORK_MARKERS;

export interface DecisionEngineOptions {
  readonly analysisId?: string;
  readonly requiredInvariantFamilies?: ReadonlySet<MinimumInvariantFamilyId>;
  readonly activityRisk?: ActivityClassification;
  readonly activityScopeQuestion?: string;
  /** The user's own requirement, used to reject model-authored generic checklist questions. */
  readonly userRequirement?: string;
}

export type RouteEliminationReason =
  | "hard_constraint"
  | "pattern_conflict"
  | "missing_invariant"
  | "equivalent_consequence"
  | "dominated";

export interface RouteEliminationTrace {
  readonly route_id: string;
  readonly reason: RouteEliminationReason;
  readonly detail: string;
  readonly missing_invariant_ids: RouteMinimumInvariantResult["missing_invariant_ids"];
}

export interface RouteFilteringResult {
  /** Routes that pass the model-declared hard constraints. */
  readonly satisfying: readonly CandidateRoute[];
  /** Routes that additionally pass the minimum pattern invariants. */
  readonly invariant_satisfying: readonly CandidateRoute[];
  readonly merged: readonly CandidateRoute[];
  readonly undominated: readonly CandidateRoute[];
  readonly invariant_trace: readonly RouteMinimumInvariantResult[];
  readonly eliminated: readonly RouteEliminationTrace[];
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

function materialConsequences(route: CandidateRoute): CandidateRoute["consequences"] {
  return route.consequences
    .filter((consequence) => consequence.user_visible && consequence.significance !== "minor")
    .map((consequence) => ({ ...consequence }))
    .sort((left, right) =>
      normalizeText(left.dimension).localeCompare(normalizeText(right.dimension)) ||
      normalizeText(left.outcome).localeCompare(normalizeText(right.outcome)) ||
      left.significance.localeCompare(right.significance),
    );
}

function materialConsequenceSignature(route: CandidateRoute): string {
  return JSON.stringify(
    materialConsequences(route).map((consequence) => ({
      dimension: normalizeText(consequence.dimension),
      outcome: normalizeText(consequence.outcome),
      significance: consequence.significance,
    })),
  );
}

/** Stable route ordering uses validated route data and never candidate position. */
export function canonicalRouteKey(route: CandidateRoute): string {
  return JSON.stringify(stableValue({
    material_consequences: JSON.parse(materialConsequenceSignature(route)) as unknown,
    pattern: route.architecture.pattern,
    scores: route.scores,
    capability_profile: route.capability_profile,
    satisfied_invariant_ids: [...route.satisfied_invariant_ids].sort(),
    id: route.id,
  }));
}

function compareRoutes(left: CandidateRoute, right: CandidateRoute): number {
  return canonicalRouteKey(left).localeCompare(canonicalRouteKey(right));
}

function canonicalRoutes(routes: readonly CandidateRoute[]): CandidateRoute[] {
  return [...routes].sort(compareRoutes);
}

const CONSEQUENCE_STOP_WORDS = new Set([
  "a", "an", "and", "at", "be", "for", "from", "in", "is", "of", "on", "or", "the", "to", "with",
]);

function consequenceTokens(value: string): ReadonlySet<string> {
  return new Set(
    normalizeText(value)
      .split(" ")
      .filter((token) => token.length > 1 && !CONSEQUENCE_STOP_WORDS.has(token)),
  );
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function equivalentMaterialConsequences(
  left: CandidateRoute,
  right: CandidateRoute,
): boolean {
  const leftMaterial = materialConsequences(left);
  const rightMaterial = materialConsequences(right);
  if (leftMaterial.length !== rightMaterial.length) return false;
  return leftMaterial.every((leftConsequence, index) => {
    const rightConsequence = rightMaterial[index];
    if (rightConsequence === undefined) return false;
    return normalizeText(leftConsequence.dimension) === normalizeText(rightConsequence.dimension) &&
      leftConsequence.significance === rightConsequence.significance &&
      jaccard(
        consequenceTokens(leftConsequence.outcome),
        consequenceTokens(rightConsequence.outcome),
      ) >= 0.8;
  });
}

export function routeDominates(left: CandidateRoute, right: CandidateRoute): boolean {
  let strictlyBetter = false;
  for (const key of SCORE_KEYS) {
    if (left.scores[key] < right.scores[key]) return false;
    if (left.scores[key] > right.scores[key]) strictlyBetter = true;
  }
  return strictlyBetter;
}

function selectEquivalentRoute(
  left: CandidateRoute,
  right: CandidateRoute,
  recommendedRouteId: string,
): CandidateRoute {
  if (routeDominates(left, right)) return left;
  if (routeDominates(right, left)) return right;
  if (left.id === recommendedRouteId) return left;
  if (right.id === recommendedRouteId) return right;
  return compareRoutes(left, right) <= 0 ? left : right;
}

function routeSatisfiesAllConstraints(
  route: CandidateRoute,
  constraintIds: ReadonlySet<string>,
): boolean {
  if (constraintIds.size === 0) return true;
  const evaluations = new Map(
    route.constraint_evaluations.map((evaluation) => [evaluation.constraint_id, evaluation.satisfies]),
  );
  return [...constraintIds].every((constraintId) => evaluations.get(constraintId) === true);
}

function sortEliminations(
  traces: readonly RouteEliminationTrace[],
): readonly RouteEliminationTrace[] {
  return [...traces].sort((left, right) =>
    left.route_id.localeCompare(right.route_id) ||
    left.reason.localeCompare(right.reason) ||
    left.detail.localeCompare(right.detail),
  );
}

/**
 * Deterministic false-choice filter:
 * hard constraints -> minimum invariants -> equivalent consequences -> dominance.
 */
export function filterCandidateRoutes(
  analysisInput: ModelAnalysis,
  options: Pick<DecisionEngineOptions, "requiredInvariantFamilies"> = {},
): RouteFilteringResult {
  const analysis = ModelAnalysisSchema.parse(analysisInput);
  const constraintIds = new Set(analysis.hard_constraints.map((constraint) => constraint.id));
  const eliminated: RouteEliminationTrace[] = [];

  const satisfying = canonicalRoutes(analysis.candidate_routes.filter((route) => {
    const accepted = routeSatisfiesAllConstraints(route, constraintIds);
    if (!accepted) {
      const failedIds = route.constraint_evaluations
        .filter((evaluation) => !evaluation.satisfies)
        .map((evaluation) => evaluation.constraint_id)
        .sort();
      eliminated.push({
        route_id: route.id,
        reason: "hard_constraint",
        detail: `Route does not satisfy hard constraint(s): ${failedIds.join(", ") || "unknown"}.`,
        missing_invariant_ids: [],
      });
    }
    return accepted;
  }));

  const invariantTrace = satisfying
    .map((route) => validateRouteMinimumInvariants(analysis, route, {
      ...(options.requiredInvariantFamilies === undefined
        ? {}
        : { requiredFamilies: options.requiredInvariantFamilies }),
    }))
    .sort((left, right) => left.route_id.localeCompare(right.route_id));
  const invariantByRouteId = new Map(invariantTrace.map((trace) => [trace.route_id, trace]));

  const invariantSatisfying = satisfying.filter((route) => {
    const trace = invariantByRouteId.get(route.id);
    if (trace?.eligible === true) return true;
    if (trace === undefined) throw new Error(`Missing minimum-invariant trace for route ${route.id}`);
    const detail = [
      trace.conflicts.length > 0 ? trace.conflicts.join("; ") : "",
      trace.missing_invariant_ids.length > 0
        ? `Missing invariant IDs: ${trace.missing_invariant_ids.join(", ")}.`
        : "",
    ].filter((entry) => entry.length > 0).join(" ");
    eliminated.push({
      route_id: route.id,
      reason: trace.conflicts.length > 0 ? "pattern_conflict" : "missing_invariant",
      detail,
      missing_invariant_ids: trace.missing_invariant_ids,
    });
    return false;
  });

  const groups: CandidateRoute[] = [];
  for (const route of invariantSatisfying) {
    const equivalentIndex = groups.findIndex((existing) =>
      equivalentMaterialConsequences(existing, route),
    );
    if (equivalentIndex === -1) {
      groups.push(route);
      continue;
    }
    const existing = groups[equivalentIndex];
    if (existing === undefined) throw new Error("Equivalent route group disappeared");
    const selected = selectEquivalentRoute(existing, route, analysis.recommended_route_id);
    const removed = selected.id === existing.id ? route : existing;
    groups[equivalentIndex] = selected;
    eliminated.push({
      route_id: removed.id,
      reason: "equivalent_consequence",
      detail: `Merged into route ${selected.id} because material user consequences are equivalent.`,
      missing_invariant_ids: [],
    });
  }
  const merged = canonicalRoutes(groups);

  const undominated = merged.filter((candidate) => {
    const dominator = canonicalRoutes(
      merged.filter((other) => other.id !== candidate.id && routeDominates(other, candidate)),
    )[0];
    if (dominator === undefined) return true;
    eliminated.push({
      route_id: candidate.id,
      reason: "dominated",
      detail: `Dominated on all scored dimensions by route ${dominator.id}.`,
      missing_invariant_ids: [],
    });
    return false;
  });

  return {
    satisfying,
    invariant_satisfying: invariantSatisfying,
    merged,
    undominated: canonicalRoutes(undominated),
    invariant_trace: invariantTrace,
    eliminated: sortEliminations(eliminated),
  };
}

const GENERIC_UNKNOWN_RELEVANCE_RULES = Object.freeze([
  {
    family: "multi_org",
    fact: /(?:multi[ ._-]?(?:org|organization|tenant)|tenant[ ._-]?(?:count|isolation)|organization[ ._-]?(?:count|multi)|多组织|多租户|租户隔离)/iu,
    requirement: /(?:\b(?:multi[ -]?(?:org|organization|tenant)|multiple (?:customer )?(?:companies|organizations|tenants)|separate (?:customer )?(?:companies|organizations|tenants)|tenant isolation|different companies|one tenant per (?:company|organization|customer))\b|多组织|多租户|不同公司|多个(?:公司|组织|租户)|每个(?:公司|组织|客户)(?:独立)?租户|租户隔离)/iu,
  },
  {
    family: "offline",
    fact: /(?:offline|outage|network[ ._-]?(?:loss|continuity|unavailable)|internet[ ._-]?(?:loss|continuity|unavailable)|离线|断网|无网络)/iu,
    requirement: /(?:\b(?:offline[ -]?(?:first|mode|operation|workflow|support)|work(?:ing)? offline|outage continuity)\b|\b(?:field|staff|users?|work|workflow|operations?|tasks?)\b[^.\n]{0,100}\b(?:continue|keep working|work through|during|without (?:a )?(?:network|internet)|offline|outages?|internet goes down)\b|\b(?:offline|outages?|without (?:a )?(?:network|internet)|internet goes down)\b[^.\n]{0,100}\b(?:continue|keep working|work through|field|staff|users?|workflow|operations?|tasks?)\b|(?:现场|员工|用户|工作|业务|流程|任务|操作)[^。\n]{0,60}(?:继续|不停|不能停|离线|断网|无网络|没有网络|网络中断)|(?:离线|断网|无网络|没有网络|网络中断)[^。\n]{0,60}(?:继续|不停|不能停|现场|员工|用户|工作|业务|流程|任务|操作))/iu,
  },
  {
    family: "production",
    fact: /(?:production[ ._-]?(?:use|data|records?|state)|live[ ._-]?(?:use|data|records?)|real[ ._-]?business[ ._-]?data|authoritative[ ._-]?(?:records?|state)|正式(?:运营|使用|数据)|生产(?:使用|数据|记录)|真实业务数据)/iu,
    requirement: /(?:\b(?:production (?:users?|use|business (?:data|records?|traffic)|data|records?|workloads?|traffic)|go[ -]?live|live (?:users?|use|business (?:data|records?)|data|records?|traffic)|real (?:users?|business data|business records?|records?)|authoritative (?:records?|state))\b|正式(?:运营|使用|业务数据|业务记录)|生产(?:使用|业务数据|业务记录|数据|记录)|真实业务数据|真实业务记录|实际用户)/iu,
  },
] as const);

const EXPLICIT_MULTI_ORG_REQUIRED = /(?:\b(?:multiple (?:customer )?(?:companies|organizations|tenants)|separate (?:customer )?(?:companies|organizations|tenants)|one tenant per (?:company|organization|customer))\b|不同公司|多个(?:公司|组织|租户)|每个(?:公司|组织|客户)(?:独立)?租户)/iu;
const EXPLICIT_MULTI_ORG_NOT_REQUIRED = /(?:\b(?:single (?:company|organization|tenant)|one (?:internal )?(?:company|organization|tenant)|no (?:external )?(?:organizations?|tenants?))\b|单一(?:公司|组织|租户)|一个(?:内部)?(?:公司|组织|租户)|没有(?:外部)?(?:组织|租户))/iu;
const EXPLICIT_OFFLINE_REQUIRED = /(?:\b(?:must|required to|cannot|can't|may not)\b[^\n]{0,100}\b(?:continue|keep working|work through|offline|without (?:a )?(?:network|internet))\b|\b(?:continue|keep working|work through)\b[^\n]{0,100}\b(?:must|required|without (?:a )?(?:network|internet)|offline)\b|(?:必须|不能|不得)[^。\n]{0,60}(?:继续|不停|离线|断网|无网络|没有网络))/iu;
const EXPLICIT_OFFLINE_NOT_REQUIRED = /(?:\b(?:can|may|allowed to)\b[^\n]{0,60}\b(?:pause|stop|wait)\b[^\n]{0,60}\b(?:outage|offline|internet|network)\b|\b(?:online only|no offline (?:mode|operation|support))\b|(?:可以|允许)[^。\n]{0,30}(?:暂停|停工|等待)[^。\n]{0,30}(?:断网|离线|网络中断)|仅联网|不需要离线)/iu;
const EXPLICIT_PRODUCTION_REQUIRED = /(?:\b(?:will|must|does|is|are)\b[^\n]{0,80}\b(?:production (?:users?|use|business (?:data|records?)|data|records?)|live (?:users?|data|records?)|authoritative (?:records?|state)|real business (?:data|records?))\b|\b(?:authoritative (?:production )?(?:records?|state)|production business (?:data|records?)|real business (?:data|records?))\b|将[^。\n]{0,40}(?:正式运营|生产使用|实际用户|真实业务数据|权威记录)|真实业务数据|真实业务记录|权威(?:业务)?记录)/iu;
const EXPLICIT_PRODUCTION_NOT_REQUIRED = /(?:\b(?:demo only|prototype only|no production (?:users?|data|records?|use)|not for production)\b|仅(?:演示|原型)|不(?:用于|涉及)(?:正式运营|生产数据|真实业务数据))/iu;

function genericFactResolved(
  family: (typeof GENERIC_UNKNOWN_RELEVANCE_RULES)[number]["family"],
  requirement: string,
): boolean {
  if (family === "multi_org") {
    return EXPLICIT_MULTI_ORG_REQUIRED.test(requirement) ||
      EXPLICIT_MULTI_ORG_NOT_REQUIRED.test(requirement);
  }
  if (family === "offline") {
    return EXPLICIT_OFFLINE_REQUIRED.test(requirement) ||
      EXPLICIT_OFFLINE_NOT_REQUIRED.test(requirement);
  }
  return EXPLICIT_PRODUCTION_REQUIRED.test(requirement) ||
    EXPLICIT_PRODUCTION_NOT_REQUIRED.test(requirement);
}

function isQuestionRelevant(fact: FoundationFact, userRequirement: string | undefined): boolean {
  if (userRequirement === undefined) return true;
  const factScope = normalizeText(`${fact.key} ${fact.label} ${fact.question ?? ""}`);
  const relevanceRule = GENERIC_UNKNOWN_RELEVANCE_RULES.find((rule) => rule.fact.test(factScope));
  if (relevanceRule === undefined) return true;
  const requirement = normalizeText(userRequirement);
  return relevanceRule.requirement.test(requirement) &&
    !genericFactResolved(relevanceRule.family, requirement);
}

function invariantFamiliesFromRequirement(
  userRequirement: string | undefined,
): ReadonlySet<MinimumInvariantFamilyId> {
  const result = new Set<MinimumInvariantFamilyId>();
  if (userRequirement === undefined) return result;
  const requirement = normalizeText(userRequirement);
  if (EXPLICIT_OFFLINE_REQUIRED.test(requirement)) result.add("offline");
  if (EXPLICIT_MULTI_ORG_REQUIRED.test(requirement)) result.add("multi_org");
  if (EXPLICIT_PRODUCTION_REQUIRED.test(requirement)) result.add("production");
  return result;
}

function isQuestionEligible(fact: FoundationFact, userRequirement: string | undefined): boolean {
  if (
    fact.certainty !== "unknown_critical" ||
    fact.kind !== "business_reality" ||
    !fact.user_owned ||
    !fact.changes_recommendation ||
    fact.question === null
  ) {
    return false;
  }
  return !TECHNICAL_CHOICE_KEYS.test(
    normalizeText(`${fact.key} ${fact.label} ${fact.question}`),
  ) && isQuestionRelevant(fact, userRequirement);
}

export function selectCriticalUnknown(
  facts: readonly FoundationFact[],
  userRequirement?: string,
): FoundationFact | undefined {
  return [...facts]
    .filter((fact) => isQuestionEligible(fact, userRequirement))
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))[0];
}

function escalationAssessments(riskState: RiskState): RiskState["domains"] {
  return riskState.domains.filter((assessment) =>
    assessment.severity === "critical" && assessment.requires_escalation,
  );
}

function requiredInvariantFamiliesForActivity(
  activityRisk: ActivityClassification,
  configured: ReadonlySet<MinimumInvariantFamilyId> | undefined,
  userRequirement: string | undefined,
): ReadonlySet<MinimumInvariantFamilyId> | undefined {
  const families = new Set([
    ...(configured ?? []),
    ...invariantFamiliesFromRequirement(userRequirement),
  ]);
  if (activityRisk.primary_activity === "money_movement") families.add("payments");
  if (activityRisk.primary_activity === "critical_privacy") families.add("sensitive");
  return families.size === 0 ? undefined : families;
}

function effectiveEscalationReason(
  riskState: RiskState,
  activityRisk: ActivityClassification,
): string {
  const reasons = escalationAssessments(riskState)
    .map((assessment) => `${assessment.domain}: ${assessment.reason}`);
  if (activityRisk.action === "specialist_review") {
    reasons.push(
      `activity ${activityRisk.primary_activity ?? "unknown"}: deterministic v${activityRisk.rules_version} activity policy requires specialist review`,
    );
  }
  return [...new Set(reasons)].sort().join("; ");
}

function defaultActivityRisk(): ActivityClassification {
  return ActivityClassificationSchema.parse({
    rules_version: 1,
    primary_activity: null,
    action: "normal",
    scope_question_key: null,
    matched_rule_ids: [],
    evidence: [],
  });
}

function hasMaterialDifference(left: CandidateRoute, right: CandidateRoute): boolean {
  return materialConsequenceSignature(left) !== materialConsequenceSignature(right) &&
    [...left.consequences, ...right.consequences].some(
      (consequence) => consequence.user_visible && consequence.significance !== "minor",
    );
}

function isDurableBusinessTradeoff(route: CandidateRoute): boolean {
  return route.tradeoff.business_owned &&
    route.tradeoff.winning_scenarios.length > 0 &&
    (route.tradeoff.difficult_to_reverse ||
      route.tradeoff.high_coupling ||
      route.tradeoff.ongoing_cost_or_operations);
}

function routeIsOnlyTechnicalForCategory(
  route: CandidateRoute,
  category: TechnicalForkCategory,
): boolean {
  const marker = TECHNICAL_FORK_MARKERS[category];
  const consequences = materialConsequences(route);
  const winningScenarios = route.tradeoff.winning_scenarios;
  const identityMatches = marker.test(normalizeText(`${route.id} ${route.name}`));
  const technicalConsequenceAxes = consequences.length > 0 &&
    consequences.every((consequence) => marker.test(normalizeText(consequence.dimension)));
  const technicalOutcomes = consequences.length > 0 &&
    consequences.every((consequence) => marker.test(normalizeText(consequence.outcome)));
  const technicalWinningScenarios = winningScenarios.length > 0 &&
    winningScenarios.every((scenario) => marker.test(normalizeText(scenario)));

  // A route name is model-authored presentation text, so it is only supporting
  // evidence. Fully non-technical material consequences and winning scenarios
  // describe a complete business case even when the route name happens to mention
  // the hosting or framework used to implement it.
  const hasCompleteBusinessCase = consequences.length > 0 &&
    consequences.every((consequence) =>
      !marker.test(normalizeText(consequence.dimension)) &&
      !marker.test(normalizeText(consequence.outcome))
    ) &&
    winningScenarios.length > 0 &&
    winningScenarios.every((scenario) => !marker.test(normalizeText(scenario)));
  if (identityMatches && hasCompleteBusinessCase) return false;

  return technicalConsequenceAxes ||
    technicalWinningScenarios ||
    (identityMatches && technicalOutcomes);
}

/**
 * Defense in depth against a model relabelling a prohibited technical choice as
 * a durable business fork. The list intentionally covers only the explicit
 * reviewed exclusions; it is not a technology catalog or policy language.
 */
function isTechnicalOnlyFork(routes: readonly CandidateRoute[]): boolean {
  if (routes.length !== 2) return false;
  const left = routes[0];
  const right = routes[1];
  if (left === undefined || right === undefined) return false;
  return (Object.keys(TECHNICAL_FORK_MARKERS) as TechnicalForkCategory[]).some((category) =>
    routeIsOnlyTechnicalForCategory(left, category) &&
    routeIsOnlyTechnicalForCategory(right, category),
  );
}

function qualifiesForTwoRoutes(routes: readonly CandidateRoute[]): routes is readonly [
  CandidateRoute,
  CandidateRoute,
] {
  if (routes.length !== 2) return false;
  const left = routes[0];
  const right = routes[1];
  return left !== undefined && right !== undefined &&
    !routeDominates(left, right) &&
    !routeDominates(right, left) &&
    hasMaterialDifference(left, right) &&
    isDurableBusinessTradeoff(left) &&
    isDurableBusinessTradeoff(right) &&
    !isTechnicalOnlyFork([left, right]);
}

function presentRoute(route: CandidateRoute): PresentedRoute {
  return PresentedRouteSchema.parse({
    id: route.id,
    name: route.name,
    recommendation: route.recommendation,
    major_drawback: route.major_drawback,
    key_assumption: route.key_assumption,
    change_condition: route.change_condition,
    consequences: route.consequences,
    proposed_stack: route.proposed_stack,
    architecture: route.architecture,
    satisfied_invariant_ids: route.satisfied_invariant_ids,
  });
}

function commonDecisionFields(
  analysis: ModelAnalysis,
  filtered: RouteFilteringResult,
  analysisId: string,
  activityRisk: ActivityClassification,
): Pick<DecisionResult, "facts" | "risk_state" | "activity_risk" | "analysis_id" | "elimination_trace" | "invariant_trace"> {
  return {
    facts: analysis.facts,
    risk_state: analysis.risk_state,
    activity_risk: activityRisk,
    analysis_id: analysisId,
    elimination_trace: filtered.eliminated.map((trace) => ({
      ...trace,
      missing_invariant_ids: [...trace.missing_invariant_ids],
    })),
    invariant_trace: filtered.invariant_trace.map((trace) => ({
      route_id: trace.route_id,
      required_invariant_ids: [...trace.required_invariant_ids],
      satisfied_invariant_ids: [...trace.satisfied_invariant_ids],
      missing_invariant_ids: [...trace.missing_invariant_ids],
      conflicts: [...trace.conflicts],
    })),
  };
}

function selectedDecisionFields(route: CandidateRoute): {
  readonly recommendation: string;
  readonly major_drawback: string;
  readonly key_assumption: string;
  readonly change_condition: string;
  readonly proposed_stack: CandidateRoute["proposed_stack"];
  readonly architecture: CandidateRoute["architecture"];
} {
  return {
    recommendation: route.recommendation,
    major_drawback: route.major_drawback,
    key_assumption: route.key_assumption,
    change_condition: route.change_condition,
    proposed_stack: route.proposed_stack,
    architecture: route.architecture,
  };
}

function selectedFeasibleRoute(
  analysis: ModelAnalysis,
  routes: readonly CandidateRoute[],
): CandidateRoute | undefined {
  const recommended = routes.find((route) => route.id === analysis.recommended_route_id);
  if (recommended !== undefined) return recommended;
  return routes.length === 1 ? routes[0] : undefined;
}

function abstain(
  analysis: ModelAnalysis,
  filtered: RouteFilteringResult,
  analysisId: string,
  reason: "no_feasible_route" | "too_many_material_routes" | "no_deterministic_winner",
  detail: string,
  missingEvidence: readonly string[],
  activityRisk: ActivityClassification,
): DecisionResult {
  return DecisionResultSchema.parse({
    ...commonDecisionFields(analysis, filtered, analysisId, activityRisk),
    interaction_mode: "abstain",
    abstention_reason: reason,
    abstention_detail: detail,
    recovery: {
      missing_fact_key: null,
      question: null,
      missing_evidence: missingEvidence,
    },
  });
}

export function decideFoundation(
  analysisInput: ModelAnalysis,
  options: DecisionEngineOptions = {},
): DecisionResult {
  const analysis = ModelAnalysisSchema.parse(analysisInput);
  const analysisId = options.analysisId ?? randomUUID();
  const activityRisk = options.activityRisk === undefined
    ? defaultActivityRisk()
    : ActivityClassificationSchema.parse(options.activityRisk);
  const requiredInvariantFamilies = requiredInvariantFamiliesForActivity(
    activityRisk,
    options.requiredInvariantFamilies,
    options.userRequirement,
  );
  const filtered = filterCandidateRoutes(analysis, {
    ...(requiredInvariantFamilies === undefined ? {} : { requiredInvariantFamilies }),
  });
  const feasible = filtered.undominated;

  if (feasible.length === 0) {
    const missing = filtered.invariant_trace
      .flatMap((trace) => trace.missing_invariant_ids)
      .filter((id, index, values) => values.indexOf(id) === index)
      .sort();
    return abstain(
      analysis,
      filtered,
      analysisId,
      "no_feasible_route",
      "No candidate route satisfies every hard constraint and required minimum invariant.",
      missing.length > 0
        ? missing.map((id) => `Provide a route that explicitly satisfies ${id}.`)
        : ["Revise a hard business constraint or provide a new feasible route."],
      activityRisk,
    );
  }

  const route = selectedFeasibleRoute(analysis, feasible);
  if (route === undefined) {
    const escalation = effectiveEscalationReason(analysis.risk_state, activityRisk);
    return abstain(
      analysis,
      filtered,
      analysisId,
      "no_deterministic_winner",
      "The recommended route was eliminated and multiple materially distinct routes remain; no replacement recommendation was selected.",
      [
        "Provide a decision-changing business fact or a corrected complete candidate analysis.",
        ...(escalation.length === 0
          ? []
          : ["Specialist-review requirements remain recorded in risk_state and activity_risk and must still be addressed."]),
      ],
      activityRisk,
    );
  }
  const common = commonDecisionFields(analysis, filtered, analysisId, activityRisk);
  const selected = selectedDecisionFields(route);
  const escalation = effectiveEscalationReason(analysis.risk_state, activityRisk);
  if (escalation.length > 0) {
    return DecisionResultSchema.parse({
      ...common,
      ...selected,
      interaction_mode: "escalate",
      escalation_reason: escalation,
    });
  }

  if (activityRisk.action === "confirm_scope") {
    return DecisionResultSchema.parse({
      ...common,
      ...selected,
      interaction_mode: "confirm_fact",
      question: options.activityScopeQuestion ??
        "Does this system only record or approve financial activity, or does it actually initiate or control funds, credit decisions, or investment recommendations?",
      question_key: activityRisk.scope_question_key ?? "financial_activity_scope",
    });
  }

  const criticalUnknown = selectCriticalUnknown(analysis.facts, options.userRequirement);
  if (criticalUnknown !== undefined) {
    return DecisionResultSchema.parse({
      ...common,
      ...selected,
      interaction_mode: "confirm_fact",
      question: criticalUnknown.question,
      question_key: criticalUnknown.key,
    });
  }

  if (feasible.length > 2) {
    return abstain(
      analysis,
      filtered,
      analysisId,
      "too_many_material_routes",
      `${feasible.length} materially distinct feasible route groups remain without a decision-changing user fact.`,
      ["Provide one material business fact that can distinguish the remaining route groups."],
      activityRisk,
    );
  }

  if (qualifiesForTwoRoutes(feasible)) {
    return DecisionResultSchema.parse({
      ...common,
      ...selected,
      interaction_mode: "offer_two_routes",
      routes: [presentRoute(feasible[0]), presentRoute(feasible[1])],
    });
  }

  if (feasible.length === 2 && isTechnicalOnlyFork(feasible)) {
    return abstain(
      analysis,
      filtered,
      analysisId,
      "no_deterministic_winner",
      "The remaining routes differ only by a technical implementation choice or mandatory baseline control, so they cannot be presented as a user-owned business fork.",
      ["Provide a corrected candidate analysis with one technically preferred route, supported by the known business facts and deterministic constraints."],
      activityRisk,
    );
  }

  return DecisionResultSchema.parse({
    ...common,
    ...selected,
    interaction_mode: "decide",
  });
}
