import { describe, expect, it } from "vitest";

import {
  classifyActivityRisk,
  type ActivityClassification,
} from "../../src/activity-risk.js";
import { FoundationAnalysisService } from "../../src/analysis-service.js";
import { InMemoryAnalysisStore } from "../../src/analysis-store.js";
import { decideFoundation } from "../../src/decision-engine.js";
import { MINIMUM_INVARIANTS_BY_FAMILY } from "../../src/invariant-ids.js";
import type { FoundationModelClient } from "../../src/model-client.js";
import type { CandidateRoute, ModelAnalysis, RiskState } from "../../src/schemas.js";
import { analysis, lowRisk, route } from "../helpers/model-fixtures.js";

function classify(
  requirement: string,
  riskState: RiskState = lowRisk,
): ActivityClassification {
  return classifyActivityRisk({ requirement, facts: [], riskState });
}

function paymentRoute(): CandidateRoute {
  return route("payment_route", {
    capability_profile: {
      ...route("base").capability_profile,
      handles_real_payments: true,
    },
    satisfied_invariant_ids: [
      ...MINIMUM_INVARIANTS_BY_FAMILY.payments,
      ...MINIMUM_INVARIANTS_BY_FAMILY.sensitive,
    ],
  });
}

function decision(
  requirement: string,
  input: ModelAnalysis = analysis([route("managed_online")]),
) {
  return decideFoundation(input, {
    activityRisk: classifyActivityRisk({
      requirement,
      facts: input.facts,
      riskState: input.risk_state,
    }),
  });
}

describe("activity risk decision integration", () => {
  it("does not escalate an ordinary reimbursement workflow for a broad financial domain", () => {
    const input = analysis([route("managed_online")], {
      risk_state: {
        level: "high",
        domains: [{
          domain: "financial",
          severity: "high",
          requires_escalation: false,
          reason: "Employees submit receipts and managers approve expense reimbursement requests.",
        }],
        reasons: ["Administrative financial workflow."],
      },
    });
    const result = decision(
      "Employees submit receipts and managers approve expense reimbursement requests.",
      input,
    );

    expect(result.interaction_mode).toBe("decide");
    expect(result.activity_risk).toMatchObject({
      primary_activity: "expense_workflow",
      action: "normal",
    });
  });

  it("keeps a read-only invoice system out of money movement", () => {
    const result = decision(
      "The tool will read and store invoices. It does not make payments or transfer funds.",
    );

    expect(result.interaction_mode).toBe("decide");
    expect(result.activity_risk).toMatchObject({
      primary_activity: "financial_records",
      action: "safeguards_required",
    });
    expect(result.activity_risk.evidence).toContainEqual(expect.objectContaining({
      rule_id: "money_movement",
      negated: true,
    }));
  });

  it.each([
    "The service initiates and authorizes real money transfers.",
    "The platform controls payments and issues refunds.",
  ])("requires specialist review for real funds activity: %s", (requirement) => {
    const result = decision(requirement, analysis([paymentRoute()]));

    expect(result.interaction_mode).toBe("escalate");
    expect(result.activity_risk).toMatchObject({
      primary_activity: "money_movement",
      action: "specialist_review",
    });
  });

  it.each([
    [
      "The service initiates and authorizes real money transfers.",
      "money_movement",
      MINIMUM_INVARIANTS_BY_FAMILY.payments,
    ],
    [
      "The service performs bulk exfiltration of personal data without authorization.",
      "critical_privacy",
      MINIMUM_INVARIANTS_BY_FAMILY.sensitive,
    ],
  ] as const)(
    "feeds %s minimum invariants through the actual decision path",
    (requirement, activity, expectedInvariantIds) => {
      const incomplete = route(`incomplete_${activity}`, {
        capability_profile: {
          ...route("base").capability_profile,
          handles_real_payments: false,
          protects_sensitive_data: false,
        },
        satisfied_invariant_ids: [],
      });
      const result = decision(requirement, analysis([incomplete]));

      expect(result.interaction_mode).toBe("abstain");
      expect(result.activity_risk.primary_activity).toBe(activity);
      if (result.interaction_mode === "abstain") {
        expect(result.abstention_reason).toBe("no_feasible_route");
      }
      expect(result.invariant_trace).toContainEqual(expect.objectContaining({
        route_id: incomplete.id,
        required_invariant_ids: [...expectedInvariantIds].sort(),
        missing_invariant_ids: [...expectedInvariantIds].sort(),
      }));
    },
  );

  it.each([
    ["The product decides whether to approve a loan and sets each credit limit.", "credit_decision"],
    ["The product recommends investments and selects a portfolio for each account.", "investment_advice"],
  ] as const)("requires specialist review for %s", (requirement, activity) => {
    const result = decision(requirement);

    expect(result.interaction_mode).toBe("escalate");
    expect(result.activity_risk).toMatchObject({
      primary_activity: activity,
      action: "specialist_review",
    });
  });

  it.each([
    [
      "The service will harvest credentials and bypass access control for protected accounts.",
      "critical_security",
    ],
    [
      "Export all personal data and publish sensitive user information without authorization.",
      "critical_privacy",
    ],
  ] as const)("does not miss %s", (requirement, activity) => {
    const result = decision(requirement);

    expect(result.interaction_mode).toBe("escalate");
    expect(result.activity_risk).toMatchObject({
      primary_activity: activity,
      action: "specialist_review",
    });
  });

  it("honors any validated critical requires_escalation assessment", () => {
    const riskState: RiskState = {
      level: "critical",
      domains: [{
        domain: "privacy",
        severity: "critical",
        requires_escalation: true,
        reason: "A validated critical disclosure risk requires specialist review.",
      }],
      reasons: [],
    };
    const input = analysis([route("managed_online")], { risk_state: riskState });
    const result = decideFoundation(input, {
      activityRisk: classify("Routine account settings.", riskState),
    });

    expect(result.interaction_mode).toBe("escalate");
    expect(result.activity_risk.primary_activity).toBe("critical_privacy");
  });

  it.each(["payment", "credit", "investment"])(
    "does not establish material activity from the lone keyword %s",
    (requirement) => {
      const result = decision(requirement);
      expect(result.interaction_mode).toBe("decide");
      expect(result.activity_risk.action).toBe("normal");
    },
  );

  it("asks exactly one scope question for contradictory financial authority", () => {
    const result = decision(
      "The platform initiates payment transfers but it does not control funds and only records activity.",
      analysis([paymentRoute()]),
    );

    expect(result.interaction_mode).toBe("confirm_fact");
    expect(result.activity_risk.action).toBe("confirm_scope");
    if (result.interaction_mode === "confirm_fact") {
      expect(result.question_key).toBe("financial_activity_scope");
      expect(result.question).toMatch(/only record or approve|只记录|initiate or control/iu);
      expect(result).not.toHaveProperty("routes");
    }
  });

  it("asks the fixed scope question for a broad financial platform", () => {
    const result = decision("Build a financial platform for our operations team.");

    expect(result.interaction_mode).toBe("confirm_fact");
    expect(result.activity_risk).toMatchObject({
      primary_activity: null,
      action: "confirm_scope",
      scope_question_key: "financial_activity_scope",
    });
  });

  it.each([
    [
      "It will only read and store invoices; it does not make payments or credit decisions.",
      "decide",
      "financial_records",
      "safeguards_required",
    ],
    [
      "It initiates and controls real transfers of funds.",
      "escalate",
      "money_movement",
      "specialist_review",
    ],
  ] as const)(
    "reclassifies a scope answer instead of repeating the question: %s",
    async (answer, mode, primaryActivity, action) => {
      let calls = 0;
      const modelClient: FoundationModelClient = {
        analyze: () => {
          calls += 1;
          return Promise.resolve(
            calls === 1
              ? analysis([route("initial")])
              : analysis([
                primaryActivity === "money_movement" ? paymentRoute() : route("record_only"),
              ]),
          );
        },
      };
      const service = new FoundationAnalysisService({
        modelClient,
        store: new InMemoryAnalysisStore(),
      });
      const initial = await service.analyze({
        request: "Build a financial platform for the operations team.",
        projectRoot: "/test",
      });
      expect(initial.interaction_mode).toBe("confirm_fact");

      const resolved = await service.answerQuestion({
        analysisId: initial.analysis_id,
        answer,
      });
      expect(resolved.interaction_mode).toBe(mode);
      expect(resolved.activity_risk).toMatchObject({
        primary_activity: primaryActivity,
        action,
        scope_question_key: null,
      });
    },
  );
});
