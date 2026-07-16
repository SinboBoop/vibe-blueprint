import { z } from "zod";

import { ActivityClassificationSchema } from "./activity-risk.js";
import { MINIMUM_INVARIANT_IDS } from "./invariant-ids.js";
import { findUnsupportedTechnologyClaims } from "./technology-claims.js";

const DecisionActivityClassificationSchema = ActivityClassificationSchema.default({
  rules_version: 1,
  primary_activity: null,
  action: "normal",
  scope_question_key: null,
  matched_rule_ids: [],
  evidence: [],
});

export const InteractionModeSchema = z.enum([
  "decide",
  "confirm_fact",
  "offer_two_routes",
  "escalate",
  "abstain",
]);

export const AbstentionReasonSchema = z.enum([
  "no_feasible_route",
  "too_many_material_routes",
  "no_deterministic_winner",
]);

export const AbstentionRecoverySchema = z
  .object({
    missing_fact_key: z.string().min(1).max(200).nullable(),
    question: z.string().min(1).max(500).nullable(),
    missing_evidence: z.array(z.string().min(1).max(500)).max(30),
  })
  .strict();

export const EliminationTraceSchema = z
  .object({
    route_id: z.string().min(1).max(96),
    reason: z.enum([
      "hard_constraint",
      "pattern_conflict",
      "missing_invariant",
      "equivalent_consequence",
      "dominated",
    ]),
    detail: z.string().min(1).max(2_000),
    missing_invariant_ids: z.array(z.enum(MINIMUM_INVARIANT_IDS)).max(15),
  })
  .strict();

export const RouteInvariantTraceSchema = z
  .object({
    route_id: z.string().min(1).max(96),
    required_invariant_ids: z.array(z.enum(MINIMUM_INVARIANT_IDS)).max(15),
    satisfied_invariant_ids: z.array(z.enum(MINIMUM_INVARIANT_IDS)).max(15),
    missing_invariant_ids: z.array(z.enum(MINIMUM_INVARIANT_IDS)).max(15),
    conflicts: z.array(z.string().min(1).max(500)).max(10),
  })
  .strict();

export const FactCertaintySchema = z.enum([
  "explicit",
  "inferred",
  "defaulted",
  "unknown_critical",
]);

export const FactKindSchema = z.enum([
  "business_reality",
  "technical_choice",
  "safety_or_compliance",
]);

export const ConstraintLevelSchema = z.enum(["hard", "preference", "context"]);

export const FactValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

/**
 * Facts deliberately carry provenance and ownership. Only an unknown, user-owned
 * business reality may become a confirm_fact question; technical choices remain
 * the engine's responsibility.
 */
export const FoundationFactSchema = z
  .object({
    id: z.string().min(1).max(96).regex(/^[a-z0-9][a-z0-9_-]*$/u),
    key: z.string().min(1).max(96).regex(/^[a-z0-9][a-z0-9_.-]*$/u),
    label: z.string().min(1).max(200),
    value: FactValueSchema,
    certainty: FactCertaintySchema,
    kind: FactKindSchema,
    source_excerpt: z.string().max(500).nullable(),
    user_owned: z.boolean(),
    changes_recommendation: z.boolean(),
    question: z.string().min(1).max(500).nullable(),
    priority: z.number().int().min(0).max(100),
    constraint_level: ConstraintLevelSchema,
    adjustable: z.boolean().nullable(),
  })
  .strict();

export const HardConstraintSchema = z
  .object({
    id: z.string().min(1).max(96).regex(/^[a-z0-9][a-z0-9_-]*$/u),
    description: z.string().min(1).max(500),
    source_fact_ids: z.array(z.string().min(1).max(96)).min(1).max(20),
  })
  .strict();

export const ConstraintEvaluationSchema = z
  .object({
    constraint_id: z.string().min(1).max(96),
    satisfies: z.boolean(),
    explanation: z.string().min(1).max(500),
  })
  .strict();

export const ArchitecturePatternSchema = z.enum([
  "static_demo",
  "managed_modular_monolith",
  "separated_api_monolith",
  "self_hosted_modular_monolith",
  "offline_first",
]);

export const RouteCapabilityProfileSchema = z
  .object({
    supports_offline_continuity: z.boolean(),
    requires_continuous_network: z.boolean(),
    meets_fixed_deadline: z.boolean(),
    handles_real_payments: z.boolean(),
    supports_multi_organization: z.boolean(),
    protects_sensitive_data: z.boolean(),
  })
  .strict();

export const ConsequenceSchema = z
  .object({
    dimension: z.string().min(1).max(100),
    outcome: z.string().min(1).max(500),
    significance: z.enum(["minor", "material", "critical"]),
    user_visible: z.boolean(),
  })
  .strict();

/** All scores use the same direction: a larger number is better. */
export const RouteScoresSchema = z
  .object({
    delivery_speed: z.number().int().min(0).max(100),
    user_value: z.number().int().min(0).max(100),
    reliability: z.number().int().min(0).max(100),
    cost_efficiency: z.number().int().min(0).max(100),
    operational_simplicity: z.number().int().min(0).max(100),
    reversibility: z.number().int().min(0).max(100),
    future_fit: z.number().int().min(0).max(100),
  })
  .strict();

export const RouteTradeoffSchema = z
  .object({
    business_owned: z.boolean(),
    difficult_to_reverse: z.boolean(),
    high_coupling: z.boolean(),
    ongoing_cost_or_operations: z.boolean(),
    winning_scenarios: z.array(z.string().min(1).max(500)).max(10),
  })
  .strict();

export const RouteFactAssumptionSchema = z
  .object({
    fact_key: z.string().min(1).max(96).regex(/^[a-z0-9][a-z0-9_.-]*$/u),
    assumed_value: z.union([z.string(), z.number(), z.boolean()]),
  })
  .strict();

export const StackComponentSchema = z
  .object({
    choice: z.string().min(1).max(300),
    rationale: z.string().min(1).max(800),
    limitation: z.string().min(1).max(800),
    replacement_cost: z.string().min(1).max(800),
  })
  .strict()
  .superRefine((component, context) => {
    for (const [field, value] of Object.entries(component)) {
      for (const finding of findUnsupportedTechnologyClaims(value)) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${finding.kind}: use a compatibility range or install-time latest stable wording; exact prices and absolute vendor claims require authoritative dated evidence`,
        });
      }
    }
  });

export const ProposedStackSchema = z
  .object({
    client: StackComponentSchema,
    server: StackComponentSchema,
    database: StackComponentSchema,
    authentication: StackComponentSchema,
    file_storage: StackComponentSchema,
    background_jobs: StackComponentSchema,
    deployment: StackComponentSchema,
    testing: StackComponentSchema,
    logging_and_monitoring: StackComponentSchema,
    data_migrations_and_backups: StackComponentSchema,
    rationale: z.string().min(1).max(1_500),
    major_limit: z.string().min(1).max(1_000),
    replacement_cost: z.string().min(1).max(1_000),
  })
  .strict()
  .superRefine((stack, context) => {
    for (const field of ["rationale", "major_limit", "replacement_cost"] as const) {
      for (const finding of findUnsupportedTechnologyClaims(stack[field])) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${finding.kind}: use a compatibility range or install-time latest stable wording; exact prices and absolute vendor claims require authoritative dated evidence`,
        });
      }
    }
  });

export const ArchitectureSchema = z
  .object({
    pattern: ArchitecturePatternSchema,
    deployment_shape: z.string().min(1).max(1_000),
    modules: z.array(z.string().min(1).max(300)).min(1).max(30),
    data_flow: z.string().min(1).max(1_500),
    failure_strategy: z.string().min(1).max(1_000),
    security_baseline: z.string().min(1).max(1_000),
    boundaries: z.array(z.string().min(1).max(500)).max(30),
  })
  .strict();

export const RiskDomainSchema = z.enum([
  "medical",
  "financial",
  "children_data",
  "complex_compliance",
  "capability_boundary",
  "security",
  "privacy",
  "payments",
  "general",
]);

export const RiskDomainAssessmentSchema = z
  .object({
    domain: RiskDomainSchema,
    severity: z.enum(["low", "moderate", "high", "critical"]),
    requires_escalation: z.boolean(),
    reason: z.string().min(1).max(800),
  })
  .strict();

export const RiskStateSchema = z
  .object({
    level: z.enum(["low", "moderate", "high", "critical"]),
    domains: z.array(RiskDomainAssessmentSchema).max(20),
    reasons: z.array(z.string().min(1).max(800)).max(20),
  })
  .strict();

export const CandidateRouteSchema = z
  .object({
    id: z.string().min(1).max(96).regex(/^[a-z0-9][a-z0-9_-]*$/u),
    name: z.string().min(1).max(200),
    recommendation: z.string().min(1).max(1_500),
    major_drawback: z.string().min(1).max(1_000),
    key_assumption: z.string().min(1).max(1_000),
    change_condition: z.string().min(1).max(1_000),
    constraint_evaluations: z.array(ConstraintEvaluationSchema).max(30),
    satisfied_invariant_ids: z
      .array(z.enum(MINIMUM_INVARIANT_IDS))
      .max(15)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "satisfied_invariant_ids must not contain duplicates",
      }),
    capability_profile: RouteCapabilityProfileSchema,
    consequences: z.array(ConsequenceSchema).max(30),
    scores: RouteScoresSchema,
    tradeoff: RouteTradeoffSchema,
    fact_assumptions: z
      .array(RouteFactAssumptionSchema)
      .max(30)
      .refine((assumptions) => new Set(assumptions.map((entry) => entry.fact_key)).size === assumptions.length, {
        message: "fact_assumptions must not contain duplicate fact_key values",
      }),
    proposed_stack: ProposedStackSchema,
    architecture: ArchitectureSchema,
  })
  .strict();

/** The only model-authored document accepted by the deterministic engine. */
export const ModelAnalysisSchema = z
  .object({
    facts: z.array(FoundationFactSchema).max(100),
    hard_constraints: z.array(HardConstraintSchema).max(30),
    candidate_routes: z.array(CandidateRouteSchema).min(1).max(3),
    recommended_route_id: z.string().min(1).max(96),
    risk_state: RiskStateSchema,
  })
  .strict()
  .superRefine((analysis, context) => {
    const factIds = new Set<string>();
    for (const [index, fact] of analysis.facts.entries()) {
      if (factIds.has(fact.id)) {
        context.addIssue({
          code: "custom",
          path: ["facts", index, "id"],
          message: `Duplicate fact id: ${fact.id}`,
        });
      }
      factIds.add(fact.id);
    }

    const constraintIds = new Set<string>();
    for (const [index, constraint] of analysis.hard_constraints.entries()) {
      if (constraintIds.has(constraint.id)) {
        context.addIssue({
          code: "custom",
          path: ["hard_constraints", index, "id"],
          message: `Duplicate hard constraint id: ${constraint.id}`,
        });
      }
      constraintIds.add(constraint.id);
      for (const sourceFactId of constraint.source_fact_ids) {
        if (!factIds.has(sourceFactId)) {
          context.addIssue({
            code: "custom",
            path: ["hard_constraints", index, "source_fact_ids"],
            message: `Unknown source fact id: ${sourceFactId}`,
          });
        }
      }
    }

    const routeIds = new Set<string>();
    const factKeys = new Set(analysis.facts.map((fact) => fact.key));
    const requiredAssumptionKeys = analysis.facts
      .filter((fact) =>
        fact.certainty === "unknown_critical" &&
        fact.user_owned &&
        fact.changes_recommendation,
      )
      .map((fact) => fact.key);
    for (const [routeIndex, route] of analysis.candidate_routes.entries()) {
      if (routeIds.has(route.id)) {
        context.addIssue({
          code: "custom",
          path: ["candidate_routes", routeIndex, "id"],
          message: `Duplicate route id: ${route.id}`,
        });
      }
      routeIds.add(route.id);
      const assumedKeys = new Set(route.fact_assumptions.map((entry) => entry.fact_key));
      for (const [assumptionIndex, assumption] of route.fact_assumptions.entries()) {
        if (!factKeys.has(assumption.fact_key)) {
          context.addIssue({
            code: "custom",
            path: ["candidate_routes", routeIndex, "fact_assumptions", assumptionIndex, "fact_key"],
            message: `Unknown assumed fact key: ${assumption.fact_key}`,
          });
        }
      }
      for (const factKey of requiredAssumptionKeys) {
        if (!assumedKeys.has(factKey)) {
          context.addIssue({
            code: "custom",
            path: ["candidate_routes", routeIndex, "fact_assumptions"],
            message: `Missing route assumption for decision-changing unknown fact: ${factKey}`,
          });
        }
      }
      const offlineUnknown = analysis.facts.find((fact) =>
        fact.key === "operations.offline_continuity" &&
        fact.certainty === "unknown_critical" &&
        fact.changes_recommendation,
      );
      const offlineAssumption = route.fact_assumptions.find((entry) =>
        entry.fact_key === "operations.offline_continuity",
      );
      if (
        offlineUnknown !== undefined &&
        route.capability_profile.requires_continuous_network &&
        offlineAssumption?.assumed_value !== true
      ) {
        context.addIssue({
          code: "custom",
          path: ["candidate_routes", routeIndex, "fact_assumptions"],
          message: "A continuously connected route must assume operations.offline_continuity=true (work may pause during an outage)",
        });
      }
      const evaluated = new Set<string>();
      for (const [evaluationIndex, evaluation] of route.constraint_evaluations.entries()) {
        if (!constraintIds.has(evaluation.constraint_id)) {
          context.addIssue({
            code: "custom",
            path: ["candidate_routes", routeIndex, "constraint_evaluations", evaluationIndex],
            message: `Unknown constraint id: ${evaluation.constraint_id}`,
          });
        }
        if (evaluated.has(evaluation.constraint_id)) {
          context.addIssue({
            code: "custom",
            path: ["candidate_routes", routeIndex, "constraint_evaluations", evaluationIndex],
            message: `Duplicate constraint evaluation: ${evaluation.constraint_id}`,
          });
        }
        evaluated.add(evaluation.constraint_id);
      }
      for (const constraintId of constraintIds) {
        if (!evaluated.has(constraintId)) {
          context.addIssue({
            code: "custom",
            path: ["candidate_routes", routeIndex, "constraint_evaluations"],
            message: `Missing evaluation for hard constraint: ${constraintId}`,
          });
        }
      }
    }
    if (!routeIds.has(analysis.recommended_route_id)) {
      context.addIssue({
        code: "custom",
        path: ["recommended_route_id"],
        message: "recommended_route_id must name a candidate route",
      });
    }
  });

export const PresentedRouteSchema = CandidateRouteSchema.pick({
  id: true,
  name: true,
  recommendation: true,
  major_drawback: true,
  key_assumption: true,
  change_condition: true,
  consequences: true,
  proposed_stack: true,
  architecture: true,
  satisfied_invariant_ids: true,
}).strict();

const DecisionResultCommonSchema = z
  .object({
    interaction_mode: InteractionModeSchema,
    facts: z.array(FoundationFactSchema),
    risk_state: RiskStateSchema,
    activity_risk: DecisionActivityClassificationSchema,
    analysis_id: z.uuid(),
    elimination_trace: z.array(EliminationTraceSchema).max(30).default([]),
    invariant_trace: z.array(RouteInvariantTraceSchema).max(10).default([]),
  })
  .strict();

const SelectedDecisionResultBaseSchema = DecisionResultCommonSchema.extend({
    recommendation: z.string().min(1),
    major_drawback: z.string().min(1),
    key_assumption: z.string().min(1),
    change_condition: z.string().min(1),
    proposed_stack: ProposedStackSchema,
    architecture: ArchitectureSchema,
  })
  .strict();

export const DecisionResultSchema = z.discriminatedUnion("interaction_mode", [
  SelectedDecisionResultBaseSchema.extend({
    interaction_mode: z.literal("decide"),
  }).strict(),
  SelectedDecisionResultBaseSchema.extend({
    interaction_mode: z.literal("confirm_fact"),
    question: z.string().min(1).max(500),
    question_key: z.string().min(1).max(200).optional(),
  }).strict(),
  SelectedDecisionResultBaseSchema.extend({
    interaction_mode: z.literal("offer_two_routes"),
    routes: z.tuple([PresentedRouteSchema, PresentedRouteSchema]),
  }).strict(),
  SelectedDecisionResultBaseSchema.extend({
    interaction_mode: z.literal("escalate"),
    escalation_reason: z.string().min(1).max(2_000),
  }).strict(),
  DecisionResultCommonSchema.extend({
    interaction_mode: z.literal("abstain"),
    abstention_reason: AbstentionReasonSchema,
    abstention_detail: z.string().min(1).max(2_000),
    recovery: AbstentionRecoverySchema,
  }).strict(),
]);

export type InteractionMode = z.infer<typeof InteractionModeSchema>;
export type AbstentionReason = z.infer<typeof AbstentionReasonSchema>;
export type FoundationFact = z.infer<typeof FoundationFactSchema>;
export type HardConstraint = z.infer<typeof HardConstraintSchema>;
export type RiskDomainAssessment = z.infer<typeof RiskDomainAssessmentSchema>;
export type CandidateRoute = z.infer<typeof CandidateRouteSchema>;
export type ProposedStack = z.infer<typeof ProposedStackSchema>;
export type Architecture = z.infer<typeof ArchitectureSchema>;
export type RiskState = z.infer<typeof RiskStateSchema>;
export type ModelAnalysis = z.infer<typeof ModelAnalysisSchema>;
export type PresentedRoute = z.infer<typeof PresentedRouteSchema>;
export type DecisionResult = z.infer<typeof DecisionResultSchema>;

/**
 * JSON Schema sent on the wire. It is generated from the same strict Zod schema
 * used at runtime so provider validation and local validation cannot drift.
 */
export const MODEL_ANALYSIS_JSON_SCHEMA: Readonly<Record<string, unknown>> = (() => {
  const generated = JSON.parse(
    JSON.stringify(z.toJSONSchema(ModelAnalysisSchema, { target: "draft-07" })),
  ) as Record<string, unknown>;
  delete generated.$schema;
  return Object.freeze(generated);
})();
