import { describe, expect, it } from "vitest";

import {
  decideFoundation,
  filterCandidateRoutes,
} from "../../src/decision-engine.js";
import { analysis, fact, route } from "../helpers/model-fixtures.js";

describe("deterministic false-choice filter inventory", () => {
  it("merges fastest launch and mobile-ready labels when consequences are equivalent", () => {
    const fastest = route("fastest_launch");
    const mobileReady = route("mobile_ready", {
      name: "Leave room for a mobile client",
      recommendation: "Use the same modular server boundary while keeping a future mobile client possible.",
      consequences: [{
        dimension: "launch outcome",
        outcome: "service launches on time",
        significance: "material",
        user_visible: true,
      }],
    });
    const input = analysis([fastest, mobileReady], { recommended_route_id: fastest.id });

    expect(filterCandidateRoutes(input).merged).toHaveLength(1);
    expect(decideFoundation(input).interaction_mode).toBe("decide");
  });

  it("removes a route that is dominated on every score", () => {
    const stronger = route("stronger", {
      consequences: [{ dimension: "outcome", outcome: "strong outcome", significance: "material", user_visible: true }],
      scores: {
        delivery_speed: 90, user_value: 90, reliability: 90, cost_efficiency: 90,
        operational_simplicity: 90, reversibility: 90, future_fit: 90,
      },
    });
    const weaker = route("weaker", {
      consequences: [{ dimension: "outcome", outcome: "weaker outcome", significance: "material", user_visible: true }],
      scores: {
        delivery_speed: 80, user_value: 80, reliability: 80, cost_efficiency: 80,
        operational_simplicity: 80, reversibility: 80, future_fit: 80,
      },
    });

    const filtered = filterCandidateRoutes(analysis([stronger, weaker]));
    expect(filtered.undominated.map((candidate) => candidate.id)).toEqual(["stronger"]);
    expect(filtered.eliminated).toContainEqual(expect.objectContaining({ route_id: "weaker", reason: "dominated" }));
  });

  it("keeps the stronger equivalent route even when the model recommended the weaker label", () => {
    const stronger = route("stronger", {
      scores: {
        delivery_speed: 90, user_value: 90, reliability: 90, cost_efficiency: 90,
        operational_simplicity: 90, reversibility: 90, future_fit: 90,
      },
    });
    const weaker = route("weaker", {
      scores: {
        delivery_speed: 70, user_value: 70, reliability: 70, cost_efficiency: 70,
        operational_simplicity: 70, reversibility: 70, future_fit: 70,
      },
    });
    const filtered = filterCandidateRoutes(analysis([stronger, weaker], {
      recommended_route_id: "weaker",
    }));

    expect(filtered.merged.map((candidate) => candidate.id)).toEqual(["stronger"]);
  });

  it("asks exactly one user-owned reality question when offline continuity is unknown", () => {
    const secondary = fact({
      id: "deadline_adjustable",
      key: "schedule.deadline_adjustable",
      label: "Can the launch date move?",
      question: "Can the launch date move?",
      priority: 50,
    });
    const result = decideFoundation(analysis([route("managed_online")], { facts: [secondary, fact()] }));

    expect(result.interaction_mode).toBe("confirm_fact");
    if (result.interaction_mode === "confirm_fact") {
      expect(result.question).toBe("If the internet goes down, can the team pause work until it returns?");
      expect(Object.keys(result).filter((key) => key === "question")).toHaveLength(1);
    }
  });

  it("decides the online route when work may stop during an outage", () => {
    const online = route("managed_online");
    const result = decideFoundation(analysis([online], {
      facts: [fact({ value: true, certainty: "explicit", question: null, changes_recommendation: false })],
    }));
    expect(result.interaction_mode).toBe("decide");
    if (result.interaction_mode === "decide") {
      expect(result.recommendation).toContain("managed_online");
    }
  });

  it("filters the online route and recommends offline-first when work cannot stop", () => {
    const offlineConstraint = {
      id: "must_continue_offline",
      description: "Work must continue through internet outages.",
      source_fact_ids: ["offline_continuity"],
    };
    const online = route("managed_online", {
      constraint_evaluations: [{ constraint_id: offlineConstraint.id, satisfies: false, explanation: "It requires a network." }],
    });
    const offline = route("offline_first", {
      constraint_evaluations: [{ constraint_id: offlineConstraint.id, satisfies: true, explanation: "It keeps a local operational store." }],
    });
    const result = decideFoundation(analysis([online, offline], {
      facts: [fact({ value: false, certainty: "explicit", question: null, constraint_level: "hard", adjustable: false })],
      hard_constraints: [offlineConstraint],
      recommended_route_id: online.id,
    }));

    expect(result.interaction_mode).toBe("decide");
    if (result.interaction_mode === "decide") {
      expect(result.recommendation).toContain("offline_first");
    }
  });

  it("does not repeat an offline question that the raw requirement already answered", () => {
    const result = decideFoundation(analysis([route("offline_first")], { facts: [fact()] }), {
      userRequirement: "Field staff must continue material work without a network and synchronize later.",
    });

    expect(result.interaction_mode).toBe("decide");
    if (result.interaction_mode === "decide") {
      expect(result.architecture.pattern).toBe("offline_first");
    }
  });

  it("rejects an online route when the raw requirement explicitly requires offline continuity", () => {
    const result = decideFoundation(analysis([route("managed_online")], { facts: [fact()] }), {
      userRequirement: "Field staff must continue material work without a network and synchronize later.",
    });

    expect(result.interaction_mode).toBe("abstain");
    if (result.interaction_mode === "abstain") {
      expect(result.abstention_reason).toBe("no_feasible_route");
    }
  });

  it("offers two routes only for the fixed-deadline versus offline-continuity conflict", () => {
    const dateFirst = route("protect_deadline", {
      consequences: [
        { dimension: "launch date", outcome: "the fixed date is protected", significance: "critical", user_visible: true },
        { dimension: "outage operations", outcome: "work pauses during outages at launch", significance: "critical", user_visible: true },
      ],
      scores: {
        delivery_speed: 95, user_value: 70, reliability: 60, cost_efficiency: 90,
        operational_simplicity: 90, reversibility: 40, future_fit: 70,
      },
      tradeoff: {
        business_owned: true,
        difficult_to_reverse: true,
        high_coupling: true,
        ongoing_cost_or_operations: false,
        winning_scenarios: ["The date is contractually more important than launch-day outage continuity."],
      },
    });
    const offlineFirst = route("offline_first", {
      capability_profile: {
        supports_offline_continuity: true,
        requires_continuous_network: false,
        meets_fixed_deadline: false,
        handles_real_payments: false,
        supports_multi_organization: false,
        protects_sensitive_data: true,
      },
      consequences: [
        { dimension: "launch date", outcome: "the date moves to complete synchronization safely", significance: "critical", user_visible: true },
        { dimension: "outage operations", outcome: "work continues during outages at launch", significance: "critical", user_visible: true },
      ],
      scores: {
        delivery_speed: 50, user_value: 95, reliability: 95, cost_efficiency: 55,
        operational_simplicity: 45, reversibility: 60, future_fit: 95,
      },
      tradeoff: {
        business_owned: true,
        difficult_to_reverse: true,
        high_coupling: true,
        ongoing_cost_or_operations: true,
        winning_scenarios: ["Outage continuity is more important than preserving the target date."],
      },
    });
    const result = decideFoundation(analysis([dateFirst, offlineFirst], {
      facts: [
        fact({ value: false, certainty: "explicit", question: null, constraint_level: "preference", adjustable: true }),
        fact({
          id: "fixed_deadline", key: "schedule.fixed_deadline", label: "Fixed launch date",
          value: "2026-09-01", certainty: "explicit", question: null, priority: 90,
          constraint_level: "preference", adjustable: true,
        }),
      ],
    }));

    expect(result.interaction_mode).toBe("offer_two_routes");
    if (result.interaction_mode === "offer_two_routes") expect(result.routes).toHaveLength(2);
  });

  it.each([
    ["frontend_framework", "React or Vue?"],
    ["api_style", "REST or GraphQL?"],
  ])("never asks about technical choice %s", (key, question) => {
    const result = decideFoundation(analysis([route("managed_online")], {
      facts: [fact({ id: key, key, label: question, question, kind: "business_reality" })],
    }));
    expect(result.interaction_mode).toBe("decide");
  });

  it.each([
    ["medical", "Clinical treatment recommendations require qualified clinical review."],
    ["financial", "Regulated financial advice requires qualified legal and risk review."],
    ["children_data", "Children's data requires specialist privacy review."],
    ["complex_compliance", "The compliance regime is beyond the automated production boundary."],
    ["capability_boundary", "The requested system is outside the supported V1 product scope."],
  ] as const)("escalates the %s domain", (domain, reason) => {
    const result = decideFoundation(analysis([route("managed_online")], {
      risk_state: {
        level: "critical",
        domains: [{ domain, severity: "critical", requires_escalation: true, reason }],
        reasons: [reason],
      },
    }));

    expect(result.interaction_mode).toBe("escalate");
    if (result.interaction_mode === "escalate") expect(result.escalation_reason).toContain(domain);
  });

  it("does not override a missing escalation flag from a broad domain label alone", () => {
    const result = decideFoundation(analysis([route("managed_online")], {
      risk_state: {
        level: "critical",
        domains: [{
          domain: "medical",
          severity: "critical",
          requires_escalation: false,
          reason: "The model mislabeled a medical project.",
        }],
        reasons: ["Medical domain."],
      },
    }));
    expect(result.interaction_mode).toBe("decide");
  });
});
