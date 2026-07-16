import { describe, expect, it } from "vitest";

import {
  canonicalRouteKey,
  decideFoundation,
  filterCandidateRoutes,
} from "../../src/decision-engine.js";
import type { CandidateRoute, DecisionResult, ModelAnalysis } from "../../src/schemas.js";
import { analysis, fact, route } from "../helpers/model-fixtures.js";

function permutations<Item>(items: readonly Item[]): readonly Item[][] {
  if (items.length < 2) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  );
}

function resolveEveryPermutation(input: ModelAnalysis): readonly DecisionResult[] {
  return permutations(input.candidate_routes).map((candidateRoutes) =>
    decideFoundation(
      { ...input, candidate_routes: candidateRoutes },
      { analysisId: "00000000-0000-4000-8000-000000000042" },
    ),
  );
}

function expectPermutationInvariant(input: ModelAnalysis): DecisionResult {
  const results = resolveEveryPermutation(input);
  expect(results.length).toBeGreaterThan(0);
  for (const result of results.slice(1)) expect(result).toEqual(results[0]);
  const first = results[0];
  if (first === undefined) throw new Error("Permutation suite produced no result");
  return first;
}

function consequenceRoute(
  id: string,
  dimension: string,
  outcome: string,
  overrides: Partial<CandidateRoute> = {},
): CandidateRoute {
  return route(id, {
    consequences: [{ dimension, outcome, significance: "material", user_visible: true }],
    ...overrides,
  });
}

function durableTradeoff(): CandidateRoute["tradeoff"] {
  return {
    business_owned: true,
    difficult_to_reverse: true,
    high_coupling: false,
    ongoing_cost_or_operations: false,
    winning_scenarios: ["This business consequence is the user's overriding priority."],
  };
}

describe("order-invariant route resolution", () => {
  it("selects the same representative for equivalent routes regardless of input order", () => {
    const alpha = route("alpha", {
      recommendation: "Use alpha.",
    });
    const beta = route("beta", {
      recommendation: "Use beta.",
      consequences: [{
        dimension: "launch outcome",
        outcome: "service launches on time",
        significance: "material",
        user_visible: true,
      }],
    });
    const input = analysis([alpha, beta], { recommended_route_id: "alpha" });

    const result = expectPermutationInvariant(input);
    expect(result.interaction_mode).toBe("decide");
    if (result.interaction_mode === "decide") expect(result.recommendation).toBe("Use alpha.");
  });

  it("keeps dominance filtering and elimination traces stable across permutations", () => {
    const strong = consequenceRoute("strong", "reliability", "verified recovery", {
      scores: {
        delivery_speed: 90,
        user_value: 90,
        reliability: 90,
        cost_efficiency: 90,
        operational_simplicity: 90,
        reversibility: 90,
        future_fit: 90,
      },
    });
    const weak = consequenceRoute("weak", "delivery", "limited recovery", {
      scores: {
        delivery_speed: 70,
        user_value: 70,
        reliability: 70,
        cost_efficiency: 70,
        operational_simplicity: 70,
        reversibility: 70,
        future_fit: 70,
      },
    });
    const input = analysis([weak, strong], { recommended_route_id: "strong" });

    const result = expectPermutationInvariant(input);
    expect(result.interaction_mode).toBe("decide");
    expect(result.elimination_trace).toContainEqual(expect.objectContaining({
      route_id: "weak",
      reason: "dominated",
    }));
  });

  it("offers exactly two genuine routes in canonical order", () => {
    const deadline = consequenceRoute("deadline", "launch", "launches on the fixed date", {
      scores: {
        delivery_speed: 95,
        user_value: 70,
        reliability: 60,
        cost_efficiency: 90,
        operational_simplicity: 90,
        reversibility: 50,
        future_fit: 65,
      },
      tradeoff: durableTradeoff(),
    });
    const continuity = consequenceRoute("continuity", "outage", "work continues through outages", {
      scores: {
        delivery_speed: 55,
        user_value: 95,
        reliability: 95,
        cost_efficiency: 55,
        operational_simplicity: 45,
        reversibility: 70,
        future_fit: 95,
      },
      tradeoff: durableTradeoff(),
    });
    const input = analysis([deadline, continuity], { recommended_route_id: "deadline" });

    const result = expectPermutationInvariant(input);
    expect(result.interaction_mode).toBe("offer_two_routes");
    if (result.interaction_mode === "offer_two_routes") {
      expect(result.routes.map((candidate) => candidate.id)).toEqual(
        [deadline, continuity].sort((left, right) =>
          canonicalRouteKey(left).localeCompare(canonicalRouteKey(right)),
        ).map((candidate) => candidate.id),
      );
    }
  });

  it("keeps a genuine business fork when both complete recommendations mention the same stack", () => {
    const deadline = consequenceRoute("deadline", "launch", "launches on the fixed date", {
      recommendation: "Use PostgreSQL on Vercel and defer the offline workflow to protect the fixed launch date.",
      scores: {
        delivery_speed: 95,
        user_value: 70,
        reliability: 60,
        cost_efficiency: 90,
        operational_simplicity: 90,
        reversibility: 50,
        future_fit: 65,
      },
      tradeoff: durableTradeoff(),
    });
    const continuity = consequenceRoute("continuity", "outage", "work continues through outages", {
      recommendation: "Use PostgreSQL on Vercel and move the launch date to complete safe offline synchronization.",
      scores: {
        delivery_speed: 55,
        user_value: 95,
        reliability: 95,
        cost_efficiency: 55,
        operational_simplicity: 45,
        reversibility: 70,
        future_fit: 95,
      },
      tradeoff: durableTradeoff(),
    });
    const result = expectPermutationInvariant(analysis([deadline, continuity], {
      recommended_route_id: "deadline",
    }));

    expect(result.interaction_mode).toBe("offer_two_routes");
  });

  it("keeps a genuine business fork when route names mention hosting", () => {
    const deadline = consequenceRoute(
      "managed_hosting_deadline",
      "contractual launch date",
      "the launch commitment is met",
      {
        name: "Managed hosting protects the fixed launch date",
        scores: {
          delivery_speed: 95,
          user_value: 70,
          reliability: 60,
          cost_efficiency: 90,
          operational_simplicity: 90,
          reversibility: 50,
          future_fit: 65,
        },
        tradeoff: {
          ...durableTradeoff(),
          winning_scenarios: ["The contractual launch date cannot move."],
        },
      },
    );
    const sovereignty = consequenceRoute(
      "self_hosted_sovereignty",
      "customer data sovereignty",
      "regulated customer data remains under organization-controlled infrastructure",
      {
        name: "Self-hosted hosting satisfies required data sovereignty",
        scores: {
          delivery_speed: 55,
          user_value: 95,
          reliability: 95,
          cost_efficiency: 55,
          operational_simplicity: 45,
          reversibility: 70,
          future_fit: 95,
        },
        tradeoff: {
          ...durableTradeoff(),
          winning_scenarios: [
            "A customer contract requires data to remain under organization control.",
          ],
        },
      },
    );

    const result = expectPermutationInvariant(analysis([deadline, sovereignty], {
      recommended_route_id: deadline.id,
    }));

    expect(result.interaction_mode).toBe("offer_two_routes");
  });

  it.each([
    [
      "restaurant",
      "Restaurant outage continuity",
      "Can restaurant staff pause work while the internet is unavailable?",
    ],
    [
      "restoration",
      "Restoration schedule",
      "Can restoration work pause while a required service is unavailable?",
    ],
    [
      "platform",
      "Platform record ownership",
      "Which organization owns the platform's business records?",
    ],
    [
      "form",
      "Paper form retention",
      "Must paper form records be retained for seven years?",
    ],
  ])("does not treat the business word %s as a technical-choice token", (
    id,
    label,
    question,
  ) => {
    const result = decideFoundation(analysis([route("managed_online")], {
      facts: [fact({
        id,
        key: `business.${id}`,
        label,
        question,
      })],
    }));

    expect(result.interaction_mode).toBe("confirm_fact");
    if (result.interaction_mode === "confirm_fact") {
      expect(result.question_key).toBe(`business.${id}`);
      expect(result.question).toBe(question);
    }
  });

  it("abstains for three material route groups without a discriminator", () => {
    const candidates = [
      consequenceRoute("route_a", "ownership", "managed operations"),
      consequenceRoute("route_b", "control", "self hosted control"),
      consequenceRoute("route_c", "continuity", "specialized field workflow"),
    ];
    const result = expectPermutationInvariant(analysis(candidates, {
      recommended_route_id: "route_b",
    }));

    expect(result.interaction_mode).toBe("abstain");
    if (result.interaction_mode === "abstain") {
      expect(result.abstention_reason).toBe("too_many_material_routes");
    }
  });

  it("asks one selected material fact before abstaining on three routes", () => {
    const candidates = [
      consequenceRoute("route_a", "ownership", "managed operations"),
      consequenceRoute("route_b", "control", "self hosted control"),
      consequenceRoute("route_c", "continuity", "specialized field workflow"),
    ];
    const result = expectPermutationInvariant(analysis(candidates, {
      facts: [fact({
        id: "deployment_control",
        key: "operations.deployment_control",
        label: "Must the organization control deployment infrastructure?",
        question: "Must your organization control the deployment infrastructure?",
      })],
      recommended_route_id: "route_b",
    }));

    expect(result.interaction_mode).toBe("confirm_fact");
    if (result.interaction_mode === "confirm_fact") {
      expect(result.question_key).toBe("operations.deployment_control");
    }
  });

  it("abstains on three routes when the only model-authored unknown is unrelated to the request", () => {
    const candidates = [
      consequenceRoute("route_a", "ownership", "managed operations"),
      consequenceRoute("route_b", "control", "self hosted control"),
      consequenceRoute("route_c", "continuity", "specialized field workflow"),
    ];
    const genericMultiOrg = fact({
      id: "multi_org_unknown",
      key: "organization.multi_organization",
      label: "Will multiple organizations use the system?",
      question: "Will multiple organizations use the system?",
      priority: 100,
    });
    const result = decideFoundation(analysis(candidates, {
      facts: [genericMultiOrg],
      recommended_route_id: "route_b",
    }), {
      analysisId: "00000000-0000-4000-8000-000000000042",
      userRequirement: "Build one internal report approval tool for our company.",
    });

    expect(result.interaction_mode).toBe("abstain");
    if (result.interaction_mode === "abstain") {
      expect(result.abstention_reason).toBe("too_many_material_routes");
    }
  });

  it("does not use a first-survivor fallback after eliminating the recommendation", () => {
    const eliminated = consequenceRoute("recommended", "speed", "fast launch", {
      satisfied_invariant_ids: [],
    });
    const managed = consequenceRoute("managed", "operations", "managed ownership");
    const controlled = consequenceRoute("controlled", "control", "infrastructure control");
    const result = expectPermutationInvariant(analysis([eliminated, managed, controlled], {
      recommended_route_id: "recommended",
    }));

    expect(result.interaction_mode).toBe("abstain");
    if (result.interaction_mode === "abstain") {
      expect(result.abstention_reason).toBe("no_deterministic_winner");
      expect(result).not.toHaveProperty("recommendation");
    }
  });

  it("abstains before constructing an escalation around a fallback route", () => {
    const eliminated = consequenceRoute("recommended", "speed", "fast launch", {
      satisfied_invariant_ids: [],
    });
    const managed = consequenceRoute("managed", "operations", "managed ownership");
    const controlled = consequenceRoute("controlled", "control", "infrastructure control");
    const criticalRisk = {
      level: "critical" as const,
      domains: [{
        domain: "security" as const,
        severity: "critical" as const,
        requires_escalation: true,
        reason: "A verified critical security action requires specialist review.",
      }],
      reasons: ["Critical security action."],
    };
    const result = expectPermutationInvariant(analysis([eliminated, managed, controlled], {
      recommended_route_id: "recommended",
      risk_state: criticalRisk,
    }));

    expect(result.interaction_mode).toBe("abstain");
    if (result.interaction_mode === "abstain") {
      expect(result.abstention_reason).toBe("no_deterministic_winner");
      expect(result).not.toHaveProperty("recommendation");
      expect(result.risk_state).toEqual(criticalRisk);
      expect(result.recovery.missing_evidence).toContain(
        "Specialist-review requirements remain recorded in risk_state and activity_risk and must still be addressed.",
      );
    }
  });

  it("abstains before constructing a confirmation around a fallback route", () => {
    const eliminated = consequenceRoute("recommended", "speed", "fast launch", {
      satisfied_invariant_ids: [],
    });
    const managed = consequenceRoute("managed", "operations", "managed ownership");
    const controlled = consequenceRoute("controlled", "control", "infrastructure control");
    const unresolved = fact({
      id: "deployment_control",
      key: "operations.deployment_control",
      label: "Must the organization control deployment infrastructure?",
      question: "Must your organization control the deployment infrastructure?",
    });
    const result = expectPermutationInvariant(analysis([eliminated, managed, controlled], {
      facts: [unresolved],
      recommended_route_id: "recommended",
    }));

    expect(result.interaction_mode).toBe("abstain");
    if (result.interaction_mode === "abstain") {
      expect(result.abstention_reason).toBe("no_deterministic_winner");
      expect(result).not.toHaveProperty("recommendation");
      expect(result).not.toHaveProperty("question");
      expect(result.facts).toContainEqual(unresolved);
    }
  });

  it.each([
    ["react", "vue", "frontend framework", "React framework", "Vue framework"],
    ["postgres", "mongodb", "database", "PostgreSQL database", "MongoDB database"],
    ["prisma", "drizzle", "ORM", "Prisma ORM", "Drizzle ORM"],
    ["rest", "graphql", "API style", "REST API style", "GraphQL API style"],
    ["vercel", "self_hosted", "hosting", "Vercel hosting", "Self-hosted hosting"],
    [
      "with_authorization",
      "defer_authorization",
      "mandatory control",
      "Server-side authorization now",
      "Defer authorization and permission checks",
    ],
  ])("does not offer a model-labelled durable %s fork", (
    leftId,
    rightId,
    dimension,
    leftOutcome,
    rightOutcome,
  ) => {
    const left = consequenceRoute(leftId, dimension, leftOutcome, {
      recommendation: `Choose ${leftOutcome}.`,
      tradeoff: durableTradeoff(),
    });
    const right = consequenceRoute(rightId, dimension, rightOutcome, {
      recommendation: `Choose ${rightOutcome}.`,
      tradeoff: durableTradeoff(),
    });
    const result = expectPermutationInvariant(analysis([left, right], {
      recommended_route_id: left.id,
    }));

    expect(result.interaction_mode).toBe("abstain");
    if (result.interaction_mode === "abstain") {
      expect(result.abstention_reason).toBe("no_deterministic_winner");
      expect(result).not.toHaveProperty("recommendation");
      expect(result).not.toHaveProperty("routes");
    }
  });

  it("selects the sole route left after the recommendation is eliminated", () => {
    const eliminated = consequenceRoute("recommended", "speed", "fast launch", {
      satisfied_invariant_ids: [],
    });
    const survivor = consequenceRoute("survivor", "operations", "complete safeguards", {
      recommendation: "Use the sole complete route.",
    });
    const result = expectPermutationInvariant(analysis([eliminated, survivor], {
      recommended_route_id: "recommended",
    }));

    expect(result.interaction_mode).toBe("decide");
    if (result.interaction_mode === "decide") {
      expect(result.recommendation).toBe("Use the sole complete route.");
    }
  });

  it("returns no_feasible_route with a canonical invariant elimination trace", () => {
    const first = consequenceRoute("first", "a", "a", { satisfied_invariant_ids: [] });
    const second = consequenceRoute("second", "b", "b", { satisfied_invariant_ids: [] });
    const result = expectPermutationInvariant(analysis([second, first], {
      recommended_route_id: "second",
    }));

    expect(result.interaction_mode).toBe("abstain");
    if (result.interaction_mode === "abstain") {
      expect(result.abstention_reason).toBe("no_feasible_route");
      expect(result.elimination_trace.map((trace) => trace.route_id)).toEqual(["first", "second"]);
      expect(result.recovery.missing_evidence).toContain(
        "Provide a route that explicitly satisfies sensitive.auditability.",
      );
    }
  });

  it("keeps a stable non-recommended tie representative", () => {
    const constraint = {
      id: "deployment",
      description: "The route must meet the deployment boundary.",
      source_fact_ids: ["deployment"],
    };
    const deploymentFact = fact({
      id: "deployment",
      key: "operations.deployment",
      label: "Deployment boundary",
      value: "managed",
      certainty: "explicit",
      question: null,
      changes_recommendation: false,
      constraint_level: "hard",
      adjustable: false,
    });
    const recommended = consequenceRoute("recommended", "control", "separate", {
      constraint_evaluations: [{
        constraint_id: constraint.id,
        satisfies: false,
        explanation: "It misses the boundary.",
      }],
    });
    const alpha = route("alpha", {
      constraint_evaluations: [{
        constraint_id: constraint.id,
        satisfies: true,
        explanation: "It meets the boundary.",
      }],
    });
    const beta = route("beta", {
      constraint_evaluations: [{
        constraint_id: constraint.id,
        satisfies: true,
        explanation: "It meets the boundary.",
      }],
      consequences: [{
        dimension: "launch outcome",
        outcome: "service launches on time",
        significance: "material",
        user_visible: true,
      }],
    });
    const input = analysis([beta, recommended, alpha], {
      facts: [deploymentFact],
      hard_constraints: [constraint],
      recommended_route_id: "recommended",
    });

    const result = expectPermutationInvariant(input);
    const filtered = filterCandidateRoutes(input);
    expect(filtered.undominated).toHaveLength(1);
    expect(result.interaction_mode).toBe("decide");
  });
});
