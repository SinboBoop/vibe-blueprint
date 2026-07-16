import type {
  CandidateRoute,
  FoundationFact,
  ModelAnalysis,
  RiskState,
} from "../../src/schemas.js";
import { MINIMUM_INVARIANTS_BY_FAMILY } from "../../src/invariant-ids.js";

const stackComponent = (choice: string) => ({
  choice,
  rationale: "It matches the validated business requirements.",
  limitation: "It still needs normal operational care.",
  replacement_cost: "Changing it after launch requires planned migration work.",
});

export function route(
  id: string,
  overrides: Partial<CandidateRoute> = {},
): CandidateRoute {
  const pattern = id.includes("offline") ? "offline_first" : "managed_modular_monolith";
  return {
    id,
    name: id.replaceAll("_", " "),
    recommendation: `Use the ${id} foundation.`,
    major_drawback: "This route has a concrete delivery or operating cost.",
    key_assumption: "The recorded business facts remain true.",
    change_condition: "Reassess when a hard business fact changes.",
    constraint_evaluations: [],
    satisfied_invariant_ids: [
      ...(pattern === "offline_first" ? MINIMUM_INVARIANTS_BY_FAMILY.offline : []),
      ...MINIMUM_INVARIANTS_BY_FAMILY.sensitive,
    ],
    capability_profile: {
      supports_offline_continuity: pattern === "offline_first",
      requires_continuous_network: pattern !== "offline_first",
      meets_fixed_deadline: true,
      handles_real_payments: false,
      supports_multi_organization: false,
      protects_sensitive_data: true,
    },
    consequences: [
      {
        dimension: "launch outcome",
        outcome: "the service launches on time",
        significance: "material",
        user_visible: true,
      },
    ],
    scores: {
      delivery_speed: 80,
      user_value: 80,
      reliability: 80,
      cost_efficiency: 80,
      operational_simplicity: 80,
      reversibility: 80,
      future_fit: 80,
    },
    tradeoff: {
      business_owned: false,
      difficult_to_reverse: false,
      high_coupling: false,
      ongoing_cost_or_operations: false,
      winning_scenarios: ["The current facts remain true."],
    },
    fact_assumptions: [],
    proposed_stack: {
      client: stackComponent("install-time stable web client"),
      server: stackComponent("install-time stable Node.js server"),
      database: stackComponent("managed relational database"),
      authentication: stackComponent("managed authentication"),
      file_storage: stackComponent("managed object storage"),
      background_jobs: stackComponent("database-backed background jobs"),
      deployment: stackComponent("managed application hosting"),
      testing: stackComponent("unit and browser integration tests"),
      logging_and_monitoring: stackComponent("structured logs and managed monitoring"),
      data_migrations_and_backups: stackComponent("transactional migrations and tested backups"),
      rationale: "A cohesive managed modular monolith is the simplest complete foundation.",
      major_limit: "It depends on managed infrastructure.",
      replacement_cost: "Replacing the deployment shape later needs a controlled migration.",
    },
    architecture: {
      pattern,
      deployment_shape: "A modular monolith with explicit domain boundaries.",
      modules: ["identity", "core_domain", "operations"],
      data_flow: "Validated requests enter domain services and commit through one data boundary.",
      failure_strategy: "Fail closed, retry idempotent work, and surface actionable status.",
      security_baseline: "Least privilege, server-side authorization, encryption, and audit logs.",
      boundaries: ["The client never bypasses server authorization."],
    },
    ...overrides,
  };
}

export function fact(overrides: Partial<FoundationFact> = {}): FoundationFact {
  return {
    id: "offline_continuity",
    key: "operations.offline_continuity",
    label: "Must work continue during an internet outage?",
    value: null,
    certainty: "unknown_critical",
    kind: "business_reality",
    source_excerpt: null,
    user_owned: true,
    changes_recommendation: true,
    question: "If the internet goes down, can the team pause work until it returns?",
    priority: 100,
    constraint_level: "context",
    adjustable: null,
    ...overrides,
  };
}

export const lowRisk: RiskState = {
  level: "low",
  domains: [{ domain: "general", severity: "low", requires_escalation: false, reason: "Normal web product." }],
  reasons: [],
};

export function analysis(
  candidateRoutes: readonly CandidateRoute[],
  overrides: Partial<ModelAnalysis> = {},
): ModelAnalysis {
  const result = {
    facts: [],
    hard_constraints: [],
    candidate_routes: [...candidateRoutes],
    recommended_route_id: candidateRoutes[0]?.id ?? "missing",
    risk_state: lowRisk,
    ...overrides,
  };
  const required = result.facts.filter((entry) =>
    entry.certainty === "unknown_critical" && entry.user_owned && entry.changes_recommendation,
  );
  return {
    ...result,
    candidate_routes: result.candidate_routes.map((candidate) => ({
      ...candidate,
      fact_assumptions: [
        ...candidate.fact_assumptions,
        ...required
          .filter((entry) => !candidate.fact_assumptions.some((assumption) => assumption.fact_key === entry.key))
          .map((entry) => ({ fact_key: entry.key, assumed_value: true as const })),
      ],
    })),
  };
}
