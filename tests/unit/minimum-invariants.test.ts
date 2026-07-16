import { describe, expect, it } from "vitest";

import { MINIMUM_INVARIANTS_BY_FAMILY } from "../../src/invariant-ids.js";
import {
  computeRequiredInvariantFamilies,
  validateRouteMinimumInvariants,
} from "../../src/minimum-invariants.js";
import type { CandidateRoute, FoundationFact } from "../../src/schemas.js";
import { analysis, fact, route } from "../helpers/model-fixtures.js";

function explicitFact(
  id: string,
  key: string,
  value: FoundationFact["value"] = true,
): FoundationFact {
  return fact({
    id,
    key,
    label: key,
    value,
    certainty: "explicit",
    source_excerpt: `${key} is required`,
    question: null,
    changes_recommendation: false,
    constraint_level: "hard",
    adjustable: false,
  });
}

function withInvariantIds(
  candidate: CandidateRoute,
  ...ids: CandidateRoute["satisfied_invariant_ids"]
): CandidateRoute {
  return { ...candidate, satisfied_invariant_ids: [...new Set(ids)] };
}

describe("minimum architecture invariants", () => {
  it("rejects a static demo for authoritative production records", () => {
    const candidate = route("demo", {
      architecture: {
        ...route("base").architecture,
        pattern: "static_demo",
      },
      capability_profile: {
        ...route("base").capability_profile,
        protects_sensitive_data: false,
      },
      satisfied_invariant_ids: [...MINIMUM_INVARIANTS_BY_FAMILY.production],
    });
    const input = analysis([candidate], {
      facts: [explicitFact("production_records", "data.authoritative_production_records")],
    });

    const result = validateRouteMinimumInvariants(input, candidate);
    expect(result.eligible).toBe(false);
    expect(result.conflicts).toEqual([
      "static_demo is incompatible with required production capability.",
    ]);
  });

  it("allows a fixture-only static demo when no protected capability applies", () => {
    const candidate = route("demo", {
      architecture: {
        ...route("base").architecture,
        pattern: "static_demo",
      },
      capability_profile: {
        supports_offline_continuity: false,
        requires_continuous_network: true,
        meets_fixed_deadline: true,
        handles_real_payments: false,
        supports_multi_organization: false,
        protects_sensitive_data: false,
      },
      satisfied_invariant_ids: [],
    });
    const input = analysis([candidate]);

    expect(validateRouteMinimumInvariants(input, candidate)).toMatchObject({
      eligible: true,
      required_invariant_ids: [],
      missing_invariant_ids: [],
      conflicts: [],
    });
  });

  it.each([
    ["real business data", "Uses real business data"],
    ["正式业务数据", "系统使用正式业务数据"],
  ])("requires production invariants for production-data synonym %s", (value, label) => {
    const candidate = route("production_synonym", {
      capability_profile: { ...route("base").capability_profile, protects_sensitive_data: false },
      satisfied_invariant_ids: [],
    });
    const input = analysis([candidate], {
      facts: [fact({
        id: "production_scope",
        key: "business.data_scope",
        label,
        value,
        certainty: "explicit",
        question: null,
        constraint_level: "hard",
        adjustable: false,
      })],
    });

    expect(computeRequiredInvariantFamilies(input, candidate).has("production")).toBe(true);
  });

  it.each([
    ["data.production_records", "No production business records", "production"],
    ["data.personal_data", "No personal data", "sensitive"],
    ["payments.real_payments", "not applicable", "payments"],
  ] as const)("does not infer %s from a structured negative value", (key, value, family) => {
    const candidate = route("negative_structured_scope", {
      capability_profile: { ...route("base").capability_profile, protects_sensitive_data: false },
      satisfied_invariant_ids: [],
    });
    const input = analysis([candidate], {
      facts: [explicitFact("negative_scope", key, value)],
    });
    expect(computeRequiredInvariantFamilies(input, candidate).has(family)).toBe(false);
  });

  it.each([
    ["The app must not store production business records.", "production"],
    ["The app must not process sensitive personal data.", "sensitive"],
    ["The app must not initiate real payments.", "payments"],
    ["The app must not continue working offline during an outage.", "offline"],
    ["The app must not support multi-tenant organizations.", "multi_org"],
    ["系统不得断网继续工作。", "offline"],
    ["系统不支持多租户。", "multi_org"],
  ] as const)("keeps a negated hard constraint out of %s invariants", (description, family) => {
    const source = explicitFact("scope", "business.scope");
    const candidate = route("negated_constraint", {
      capability_profile: { ...route("base").capability_profile, protects_sensitive_data: false },
      satisfied_invariant_ids: [],
      constraint_evaluations: [{
        constraint_id: "negative_scope",
        satisfies: true,
        explanation: "The protected activity is excluded.",
      }],
    });
    const input = analysis([candidate], {
      facts: [source],
      hard_constraints: [{ id: "negative_scope", description, source_fact_ids: [source.id] }],
    });
    expect(computeRequiredInvariantFamilies(input, candidate).has(family)).toBe(false);
  });

  it("keeps production safeguards when one fact also names a payment callback", () => {
    const candidate = route("production_callback", {
      capability_profile: { ...route("base").capability_profile, protects_sensitive_data: false },
      satisfied_invariant_ids: [],
    });
    const input = analysis([candidate], {
      facts: [explicitFact(
        "combined_scope",
        "business.data_scope",
        "Stores authoritative production records and receives verified payment callbacks",
      )],
    });
    const families = computeRequiredInvariantFamilies(input, candidate);
    expect(families.has("production")).toBe(true);
    expect(families.has("payments")).toBe(true);
  });

  it.each([
    ["organization_count", 1],
    ["tenant_count", "1"],
    ["organization_count", "single organization"],
    ["tenant_count", "单租户"],
  ] as const)("does not infer multi-organization scope from %s=%s", (key, value) => {
    const candidate = route("single_organization", {
      capability_profile: { ...route("base").capability_profile, protects_sensitive_data: false },
      satisfied_invariant_ids: [],
    });
    const input = analysis([candidate], {
      facts: [explicitFact("single_scope", key, value)],
    });
    expect(computeRequiredInvariantFamilies(input, candidate).has("multi_org")).toBe(false);
  });

  it("requires offline_first and all four offline safeguards", () => {
    const incomplete = route("offline_first", {
      satisfied_invariant_ids: [
        "offline.durable_local_operations",
        "offline.sync_protocol",
        "offline.idempotent_server_application",
        ...MINIMUM_INVARIANTS_BY_FAMILY.sensitive,
      ],
    });
    const input = analysis([incomplete], {
      facts: [explicitFact("offline_continuity", "operations.offline_continuity", false)],
    });
    const failed = validateRouteMinimumInvariants(input, incomplete);
    expect(failed.eligible).toBe(false);
    expect(failed.missing_invariant_ids).toEqual(["offline.conflict_handling"]);

    const complete = withInvariantIds(
      incomplete,
      ...incomplete.satisfied_invariant_ids,
      "offline.conflict_handling",
    );
    expect(validateRouteMinimumInvariants(
      { ...input, candidate_routes: [complete] },
      complete,
    ).eligible).toBe(true);
  });

  it("rejects an online pattern that claims offline continuity", () => {
    const candidate = route("online_claim", {
      capability_profile: {
        ...route("base").capability_profile,
        supports_offline_continuity: true,
        requires_continuous_network: false,
      },
      satisfied_invariant_ids: [
        ...MINIMUM_INVARIANTS_BY_FAMILY.offline,
        ...MINIMUM_INVARIANTS_BY_FAMILY.sensitive,
      ],
    });
    const input = analysis([candidate]);

    expect(validateRouteMinimumInvariants(input, candidate).conflicts).toEqual([
      "offline requires pattern offline_first; route uses managed_modular_monolith.",
    ]);
  });

  it("requires both multi-organization isolation safeguards", () => {
    const candidate = route("multi_org", {
      capability_profile: {
        ...route("base").capability_profile,
        supports_multi_organization: true,
      },
      satisfied_invariant_ids: [
        "multi_org.data_owner_boundary",
        ...MINIMUM_INVARIANTS_BY_FAMILY.sensitive,
      ],
    });
    const input = analysis([candidate]);

    expect(validateRouteMinimumInvariants(input, candidate).missing_invariant_ids).toEqual([
      "multi_org.server_side_isolation",
    ]);
  });

  it("requires all four real-payment safeguards", () => {
    const candidate = route("payments", {
      capability_profile: {
        ...route("base").capability_profile,
        handles_real_payments: true,
      },
      satisfied_invariant_ids: [
        "payments.callback_authenticity",
        "payments.idempotent_processing",
        ...MINIMUM_INVARIANTS_BY_FAMILY.sensitive,
      ],
    });
    const input = analysis([candidate]);

    expect(validateRouteMinimumInvariants(input, candidate).missing_invariant_ids).toEqual([
      "payments.failure_recovery",
      "payments.reconciliation",
    ]);
  });

  it.each([
    [
      "payments.authoritative_callback",
      "Receives authoritative callbacks from the payment provider",
      "The provider callback is the source of truth for real payment status.",
    ],
    [
      "payments.authoritative_callback",
      "只接收权威支付回调",
      "系统接收并验证支付服务商的权威回调。",
    ],
    [
      "business.callback_scope",
      "Payment callback scope",
      "The service does not store card data and receives verified authoritative payment callbacks.",
    ],
    [
      "business.callback_scope",
      "支付回调范围",
      "系统不存储银行卡数据并接收和验签支付服务商的权威回调。",
    ],
  ])("treats authoritative payment callbacks as payments, not production records", (
    key,
    label,
    sourceExcerpt,
  ) => {
    const candidate = route("callback_consumer", {
      capability_profile: {
        ...route("base").capability_profile,
        handles_real_payments: false,
        protects_sensitive_data: false,
      },
      satisfied_invariant_ids: [],
    });
    const input = analysis([candidate], {
      facts: [fact({
        id: "authoritative_payment_callback",
        key,
        label,
        value: true,
        certainty: "explicit",
        source_excerpt: sourceExcerpt,
        question: null,
        changes_recommendation: false,
        constraint_level: "hard",
        adjustable: false,
      })],
    });

    const families = computeRequiredInvariantFamilies(input, candidate);
    expect(families.has("payments")).toBe(true);
    expect(families.has("production")).toBe(false);
    expect(validateRouteMinimumInvariants(input, candidate).missing_invariant_ids).toEqual([
      ...MINIMUM_INVARIANTS_BY_FAMILY.payments,
    ].sort());
  });

  it.each([
    "The service must accept only verified authoritative callbacks from the payment provider.",
    "系统必须只接收并验签支付服务商的权威回调。",
  ])("derives payment safeguards from an authoritative-callback hard constraint: %s", (description) => {
    const source = explicitFact("callback_scope", "payments.callback_scope");
    const candidate = route("callback_constraint", {
      capability_profile: {
        ...route("base").capability_profile,
        handles_real_payments: false,
        protects_sensitive_data: false,
      },
      constraint_evaluations: [{
        constraint_id: "trusted_payment_callback",
        satisfies: true,
        explanation: "The route can consume the callback.",
      }],
      satisfied_invariant_ids: [],
    });
    const input = analysis([candidate], {
      facts: [source],
      hard_constraints: [{
        id: "trusted_payment_callback",
        description,
        source_fact_ids: [source.id],
      }],
    });

    const families = computeRequiredInvariantFamilies(input, candidate);
    expect(families.has("payments")).toBe(true);
    expect(families.has("production")).toBe(false);
  });

  it("does not infer payment or production scope from an explicitly negated callback fact", () => {
    const candidate = route("record_only_callback", {
      capability_profile: {
        ...route("base").capability_profile,
        protects_sensitive_data: false,
      },
      satisfied_invariant_ids: [],
    });
    const input = analysis([candidate], {
      facts: [fact({
        id: "authoritative_payment_callback",
        key: "payments.authoritative_callback",
        label: "Receives authoritative payment callbacks",
        value: false,
        certainty: "explicit",
        source_excerpt: "The record-only tool never receives authoritative payment callbacks.",
        question: null,
        changes_recommendation: false,
        constraint_level: "hard",
        adjustable: false,
      })],
    });

    const families = computeRequiredInvariantFamilies(input, candidate);
    expect(families.has("payments")).toBe(false);
    expect(families.has("production")).toBe(false);
  });

  it.each([
    "The service must not receive verified authoritative callbacks from the payment provider.",
    "系统不得接收或处理支付服务商的权威回调。",
  ])("keeps an authoritative payment callback inside its local negation scope: %s", (description) => {
    const source = explicitFact("callback_scope", "business.callback_scope");
    const candidate = route("negated_callback_constraint", {
      capability_profile: {
        ...route("base").capability_profile,
        handles_real_payments: false,
        protects_sensitive_data: false,
      },
      constraint_evaluations: [{
        constraint_id: "no_payment_callback",
        satisfies: true,
        explanation: "The route does not consume payment callbacks.",
      }],
      satisfied_invariant_ids: [],
    });
    const input = analysis([candidate], {
      facts: [source],
      hard_constraints: [{
        id: "no_payment_callback",
        description,
        source_fact_ids: [source.id],
      }],
    });

    const families = computeRequiredInvariantFamilies(input, candidate);
    expect(families.has("payments")).toBe(false);
    expect(families.has("production")).toBe(false);
  });

  it("does not require payment safeguards for record-only expenses", () => {
    const candidate = route("expense_records");
    const input = analysis([candidate], {
      facts: [explicitFact("expense_records", "finance.expense_records_only")],
    });

    expect(computeRequiredInvariantFamilies(input, candidate).has("payments")).toBe(false);
  });

  it("requires all four sensitive-data safeguards", () => {
    const candidate = route("sensitive", {
      satisfied_invariant_ids: [
        "sensitive.server_side_authorization",
        "sensitive.auditability",
        "sensitive.storage_transit_protection",
      ],
    });
    const input = analysis([candidate]);

    expect(validateRouteMinimumInvariants(input, candidate).missing_invariant_ids).toEqual([
      "sensitive.retention_deletion",
    ]);
  });

  it("requires sensitive safeguards when a generic structured fact explicitly names sensitive data", () => {
    const candidate = route("generic_sensitive_fact", {
      capability_profile: {
        ...route("base").capability_profile,
        protects_sensitive_data: false,
      },
      satisfied_invariant_ids: [],
    });
    const input = analysis([candidate], {
      facts: [fact({
        id: "data_scope",
        key: "business.data_scope",
        label: "Stored business information",
        value: "patient medical records",
        certainty: "explicit",
        source_excerpt: "The service stores medical records for patients.",
        question: null,
        constraint_level: "hard",
        adjustable: false,
      })],
    });

    expect(computeRequiredInvariantFamilies(input, candidate).has("sensitive")).toBe(true);
    expect(validateRouteMinimumInvariants(input, candidate).missing_invariant_ids).toEqual([
      ...MINIMUM_INVARIANTS_BY_FAMILY.sensitive,
    ].sort());
  });

  it("uses a sensitive generic fact label and source when its boolean value confirms scope", () => {
    const candidate = route("generic_boolean_sensitive_fact", {
      capability_profile: {
        ...route("base").capability_profile,
        protects_sensitive_data: false,
      },
      satisfied_invariant_ids: [],
    });
    const input = analysis([candidate], {
      facts: [fact({
        id: "data_scope",
        key: "business.data_scope",
        label: "Stores patient medical records",
        value: true,
        certainty: "explicit",
        source_excerpt: "The product stores patient medical records.",
        question: null,
        constraint_level: "hard",
        adjustable: false,
      })],
    });

    expect(computeRequiredInvariantFamilies(input, candidate).has("sensitive")).toBe(true);
  });

  it("does not require sensitive safeguards for a generic fact that explicitly excludes sensitive data", () => {
    const candidate = route("generic_non_sensitive_fact", {
      capability_profile: {
        ...route("base").capability_profile,
        protects_sensitive_data: false,
      },
      satisfied_invariant_ids: [],
    });
    const input = analysis([candidate], {
      facts: [fact({
        id: "data_scope",
        key: "business.data_scope",
        label: "Stored business information",
        value: "No sensitive personal data or medical records",
        certainty: "explicit",
        source_excerpt: "The service stores fixture-only product names and does not store medical records.",
        question: null,
        constraint_level: "hard",
        adjustable: false,
      })],
    });

    expect(computeRequiredInvariantFamilies(input, candidate).has("sensitive")).toBe(false);
  });

  it("still requires sensitive safeguards when an earlier negation is superseded by an explicit fact", () => {
    const candidate = route("generic_mixed_sensitive_fact", {
      capability_profile: {
        ...route("base").capability_profile,
        protects_sensitive_data: false,
      },
      satisfied_invariant_ids: [],
    });
    const input = analysis([candidate], {
      facts: [fact({
        id: "data_scope",
        key: "business.data_scope",
        label: "Stored business information",
        value: "No payment details; however, the service stores medical records.",
        certainty: "explicit",
        source_excerpt: "No payment details; however, the service stores medical records.",
        question: null,
        constraint_level: "hard",
        adjustable: false,
      })],
    });

    expect(computeRequiredInvariantFamilies(input, candidate).has("sensitive")).toBe(true);
  });

  it("combines simultaneous offline, multi-org, payment, and sensitive families", () => {
    const allIds = [
      ...MINIMUM_INVARIANTS_BY_FAMILY.offline,
      ...MINIMUM_INVARIANTS_BY_FAMILY.multi_org,
      ...MINIMUM_INVARIANTS_BY_FAMILY.payments,
      ...MINIMUM_INVARIANTS_BY_FAMILY.sensitive,
    ];
    const candidate = route("offline_all", {
      capability_profile: {
        supports_offline_continuity: true,
        requires_continuous_network: false,
        meets_fixed_deadline: false,
        handles_real_payments: true,
        supports_multi_organization: true,
        protects_sensitive_data: true,
      },
      satisfied_invariant_ids: allIds,
    });
    const input = analysis([candidate]);
    const result = validateRouteMinimumInvariants(input, candidate);

    expect(result.eligible).toBe(true);
    expect(result.required_invariant_ids).toHaveLength(14);

    const missing = { ...candidate, satisfied_invariant_ids: allIds.slice(0, -1) };
    expect(validateRouteMinimumInvariants(
      { ...input, candidate_routes: [missing] },
      missing,
    ).eligible).toBe(false);
  });
});
