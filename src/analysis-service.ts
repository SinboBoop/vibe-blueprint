import {
  defaultAnalysisStore,
  type AnalysisStore,
  type StoredAnalysis,
} from "./analysis-store.js";
import { createHash } from "node:crypto";
import { classifyActivityRisk } from "./activity-risk.js";
import { decideFoundation } from "./decision-engine.js";
import { enforceFoundationBoundaryRisks } from "./foundation-boundary-risk.js";
import type {
  FoundationModelClient,
  SanitizedModelContext,
} from "./model-client.js";
import { sanitizeProjectSummary } from "./model-context.js";
import type { DecisionResult } from "./schemas.js";
import { redactSensitiveText } from "./security.js";
import type { FoundationState } from "./state.js";

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

function reassessmentKey(input: AnalyzeProjectInput, request: string): string | undefined {
  if (input.baseFoundation === undefined || input.affectedCapabilities === undefined) return undefined;
  const material = JSON.stringify(stableValue({
    project_root: input.projectRoot,
    source_hash: input.baseFoundation.source_hash,
    request,
    affected_capabilities: [...input.affectedCapabilities].sort(),
    project_summary: input.projectSummary ?? null,
    repository_context: input.context === undefined
      ? null
      : { kind: input.context.kind, content: input.context.content },
  }));
  return createHash("sha256").update(material).digest("hex");
}

export interface AnalyzeProjectInput {
  readonly request: string;
  readonly projectRoot: string;
  readonly projectSummary?: string;
  readonly baseFoundation?: FoundationState;
  readonly affectedCapabilities?: readonly string[];
  /** Repository-derived material may only enter the model through this attested context. */
  readonly context?: SanitizedModelContext;
}

export interface AnswerQuestionInput {
  readonly analysisId: string;
  readonly answer: string;
}

export interface FoundationAnalysisServiceOptions {
  readonly modelClient: FoundationModelClient;
  readonly store?: AnalysisStore;
  readonly now?: () => Date;
}

export class AnalysisNotFoundError extends Error {
  override readonly name = "AnalysisNotFoundError";
}

export class AnswerConsistencyError extends Error {
  override readonly name = "AnswerConsistencyError";
}

function valueEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function routeMatchesDecision(
  route: StoredAnalysis["modelAnalysis"]["candidate_routes"][number],
  decision: DecisionResult,
): boolean {
  return "recommendation" in decision &&
    "architecture" in decision &&
    route.recommendation === decision.recommendation &&
    valueEquals(route.architecture, decision.architecture) &&
    valueEquals(route.proposed_stack, decision.proposed_stack);
}

function priorSelectedModelRoute(prior: StoredAnalysis) {
  if (!("recommendation" in prior.decision) || !("architecture" in prior.decision)) return undefined;
  const recommendedRoute = prior.modelAnalysis.candidate_routes.find((route) =>
    route.id === prior.modelAnalysis.recommended_route_id,
  );
  if (recommendedRoute !== undefined && routeMatchesDecision(recommendedRoute, prior.decision)) {
    return recommendedRoute;
  }
  const routeByRecommendation = prior.modelAnalysis.candidate_routes.find((route) =>
    routeMatchesDecision(route, prior.decision),
  );
  return routeByRecommendation ?? prior.modelAnalysis.candidate_routes.find((route) =>
    route.id === prior.modelAnalysis.recommended_route_id,
  );
}

function selectedModelRoute(modelAnalysis: StoredAnalysis["modelAnalysis"], decision: DecisionResult) {
  if (!("recommendation" in decision) || !("architecture" in decision)) return undefined;
  const recommendedRoute = modelAnalysis.candidate_routes.find((route) =>
    route.id === modelAnalysis.recommended_route_id,
  );
  if (recommendedRoute !== undefined && routeMatchesDecision(recommendedRoute, decision)) {
    return recommendedRoute;
  }
  return modelAnalysis.candidate_routes.find((route) => routeMatchesDecision(route, decision));
}

function routeFoundationSignature(route: StoredAnalysis["modelAnalysis"]["candidate_routes"][number]): string {
  return JSON.stringify(stableValue({
    architecture_pattern: route.architecture.pattern,
    capability_profile: route.capability_profile,
    satisfied_invariant_ids: [...route.satisfied_invariant_ids].sort(),
    stack_choices: Object.fromEntries(
      Object.entries(route.proposed_stack)
        .filter(([, value]) => typeof value === "object" && "choice" in value)
        .map(([key, value]) => [
          key,
          (value as { readonly choice: string }).choice
            .normalize("NFKC")
            .toLocaleLowerCase("en-US")
            .replace(/\s+/gu, " ")
            .trim(),
        ]),
    ),
    deployment_shape: route.architecture.deployment_shape,
    modules: [...route.architecture.modules].sort(),
    data_flow: route.architecture.data_flow,
    failure_strategy: route.architecture.failure_strategy,
    security_baseline: route.architecture.security_baseline,
    boundaries: [...route.architecture.boundaries].sort(),
  }));
}

export class FoundationAnalysisService {
  readonly #modelClient: FoundationModelClient;
  readonly #store: AnalysisStore;
  readonly #now: () => Date;
  readonly #reassessmentCache = new Map<string, string>();
  readonly #inflightReassessments = new Map<string, Promise<DecisionResult>>();

  constructor(options: FoundationAnalysisServiceOptions) {
    this.#modelClient = options.modelClient;
    this.#store = options.store ?? defaultAnalysisStore;
    this.#now = options.now ?? (() => new Date());
  }

  async analyze(input: AnalyzeProjectInput): Promise<DecisionResult> {
    const request = redactSensitiveText(requireText(input.request, "request"));
    const key = reassessmentKey(input, request);
    const cachedAnalysisId = key === undefined ? undefined : this.#reassessmentCache.get(key);
    if (cachedAnalysisId !== undefined) {
      const cached = await this.#store.get(cachedAnalysisId);
      if (cached !== undefined) return cached.decision;
      if (key !== undefined) this.#reassessmentCache.delete(key);
    }
    const inflight = key === undefined ? undefined : this.#inflightReassessments.get(key);
    if (inflight !== undefined) return inflight;
    const operation = this.#analyzeOnce(input, request);
    if (key === undefined) return operation;
    this.#inflightReassessments.set(key, operation);
    try {
      const result = await operation;
      this.#reassessmentCache.set(key, result.analysis_id);
      while (this.#reassessmentCache.size > 100) {
        const oldest = this.#reassessmentCache.keys().next().value;
        if (oldest === undefined) break;
        this.#reassessmentCache.delete(oldest);
      }
      return result;
    } finally {
      this.#inflightReassessments.delete(key);
    }
  }

  async #analyzeOnce(input: AnalyzeProjectInput, request: string): Promise<DecisionResult> {
    const projectSummary = input.projectSummary === undefined
      ? undefined
      : sanitizeProjectSummary(input.projectSummary).trim();
    const modelAnalysisInput = await this.#modelClient.analyze({
      request,
      ...(input.context === undefined ? {} : { context: input.context }),
      ...(input.baseFoundation === undefined || input.affectedCapabilities === undefined
        ? {}
        : {
            foundationContext: {
              baseFoundation: input.baseFoundation,
              affectedCapabilities: input.affectedCapabilities,
            },
          }),
    });
    const modelAnalysis = {
      ...modelAnalysisInput,
      risk_state: enforceFoundationBoundaryRisks(
        request,
        modelAnalysisInput.facts,
        modelAnalysisInput.risk_state,
      ),
    };
    const activityRisk = classifyActivityRisk({
      requirement: request,
      facts: modelAnalysis.facts,
      riskState: modelAnalysis.risk_state,
    });
    const decision = decideFoundation(modelAnalysis, { activityRisk, userRequirement: request });
    const now = this.#now().toISOString();
    await this.#store.set({
      analysisId: decision.analysis_id,
      request,
      projectRoot: input.projectRoot,
      ...(projectSummary === undefined || projectSummary.length === 0
        ? {}
        : { projectSummary }),
      ...(input.baseFoundation === undefined ? {} : { baseFoundation: input.baseFoundation }),
      ...(input.affectedCapabilities === undefined ? {} : { affectedCapabilities: input.affectedCapabilities }),
      modelAnalysis,
      decision,
      createdAt: now,
      updatedAt: now,
      answers: [],
    });
    return decision;
  }

  async answerQuestion(input: AnswerQuestionInput): Promise<DecisionResult> {
    const analysisId = requireText(input.analysisId, "analysis_id");
    const answer = redactSensitiveText(requireText(input.answer, "answer"));
    const prior = await this.#store.get(analysisId);
    if (prior === undefined) {
      throw new AnalysisNotFoundError(`No active Foundation analysis found for id ${analysisId}`);
    }
    if (prior.decision.interaction_mode !== "confirm_fact") {
      throw new Error("This analysis has no outstanding reality question to answer");
    }

    const modelAnalysisInput = await this.#modelClient.analyze({
      request: prior.request,
      priorAnalysis: prior.modelAnalysis,
      answer,
    });
    const modelAnalysis = {
      ...modelAnalysisInput,
      risk_state: enforceFoundationBoundaryRisks(
        `${prior.request}\nConfirmed answer: ${answer}`,
        modelAnalysisInput.facts,
        modelAnalysisInput.risk_state,
      ),
    };
    const activityRisk = classifyActivityRisk({
      // The confirmed answer is the authoritative classifier input for the one
      // outstanding scope question. Reincluding the earlier broad phrase (for
      // example "financial platform") would manufacture the same ambiguity.
      requirement: answer,
      facts: modelAnalysis.facts,
      riskState: modelAnalysis.risk_state,
    });
    const questionKey = prior.decision.question_key;
    const explicitAnswerFact = questionKey === undefined || modelAnalysis.facts.some((fact) =>
      fact.key === questionKey &&
      fact.certainty === "explicit" &&
      fact.question === null
    );
    const deterministicScopeResolved = questionKey === "financial_activity_scope" &&
      activityRisk.action !== "confirm_scope" &&
      activityRisk.scope_question_key === null;
    if (!explicitAnswerFact && !deterministicScopeResolved) {
      throw new AnswerConsistencyError(
        `The model did not incorporate the answer as an explicit fact for ${questionKey}`,
      );
    }
    const decision = decideFoundation(modelAnalysis, {
      analysisId,
      activityRisk,
      userRequirement: `${prior.request}\n${answer}`,
    });
    const priorRoute = priorSelectedModelRoute(prior);
    const explicitAnswer = questionKey === undefined
      ? undefined
      : modelAnalysis.facts.find((fact) =>
          fact.key === questionKey && fact.certainty === "explicit" && fact.question === null,
        );
    const priorAssumption = questionKey === undefined
      ? undefined
      : priorRoute?.fact_assumptions.find((assumption) => assumption.fact_key === questionKey);
    const invalidatedSelectedRoute = priorRoute !== undefined &&
      explicitAnswer !== undefined &&
      priorAssumption !== undefined &&
      !valueEquals(priorAssumption.assumed_value, explicitAnswer.value);
    if (invalidatedSelectedRoute) {
      const nextRoute = selectedModelRoute(modelAnalysis, decision);
      if (nextRoute !== undefined && routeFoundationSignature(nextRoute) === routeFoundationSignature(priorRoute)) {
        throw new AnswerConsistencyError(
          `The explicit answer invalidated the prior route assumption for ${questionKey}, but the recommendation did not change`,
        );
      }
    }
    const updated: StoredAnalysis = {
      ...prior,
      modelAnalysis,
      decision,
      updatedAt: this.#now().toISOString(),
      answers: [...prior.answers, answer],
    };
    await this.#store.set(updated);
    return decision;
  }

  async getStoredAnalysis(analysisId: string): Promise<StoredAnalysis | undefined> {
    return this.#store.get(analysisId);
  }
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} cannot be empty`);
  return normalized;
}
