import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACTIVITY_RULE_IDS,
  classifyActivityRisk,
  DEFAULT_ACTIVITY_RISK_RULES_PATH,
  loadActivityRiskRules,
  RiskRulesInvalidError,
  validateActivityRiskRules,
} from "../../src/activity-risk.js";
import type { FoundationFact, RiskState } from "../../src/schemas.js";

interface MutableRulesFixture {
  schema_version: number;
  rules: Array<{
    id: string;
    minimum_independent_signals: number;
    positive_signal_groups: Array<{
      id: string;
      terms: { en: string[]; zh: string[] };
    }>;
    negative_signal_groups: Array<{
      id: string;
      terms: { en: string[]; zh: string[] };
    }>;
  } & Record<string, unknown>>;
  scope_confirmation: Record<string, unknown>;
}

async function rulesFixture(): Promise<MutableRulesFixture> {
  return JSON.parse(await readFile(DEFAULT_ACTIVITY_RISK_RULES_PATH, "utf8")) as MutableRulesFixture;
}

async function temporaryFile(name: string, value: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "foundation-activity-rules-"));
  const file = path.join(directory, name);
  await writeFile(file, value, "utf8");
  return file;
}

function requireRule(fixture: MutableRulesFixture, index: number): MutableRulesFixture["rules"][number] {
  const rule = fixture.rules[index];
  if (rule === undefined) throw new Error(`Missing rule fixture at index ${index}`);
  return rule;
}

function expectRulesFailure(operation: () => unknown, reason: RiskRulesInvalidError["reason"]): void {
  let error: unknown;
  try {
    operation();
  } catch (caught: unknown) {
    error = caught;
  }
  expect(error).toBeInstanceOf(RiskRulesInvalidError);
  expect(error).toMatchObject({ name: "RiskRulesInvalidError", reason });
}

const LOW_RISK: RiskState = {
  level: "low",
  domains: [{
    domain: "general",
    severity: "low",
    requires_escalation: false,
    reason: "Ordinary application.",
  }],
  reasons: [],
};

function activityFact(
  value: FoundationFact["value"],
  sourceExcerpt: string,
  overrides: Partial<FoundationFact> = {},
): FoundationFact {
  return {
    id: "activity_scope",
    key: "business.activity_scope",
    label: "What financial activity does the product perform?",
    value,
    certainty: "explicit",
    kind: "business_reality",
    source_excerpt: sourceExcerpt,
    user_owned: true,
    changes_recommendation: true,
    question: null,
    priority: 100,
    constraint_level: "hard",
    adjustable: false,
    ...overrides,
  };
}

describe("activity risk rules", () => {
  it("loads and immutably caches exactly the seven bilingual activity rules", () => {
    const first = loadActivityRiskRules();
    const second = loadActivityRiskRules();

    expect(second).toBe(first);
    expect(first.schema_version).toBe(1);
    expect(first.scope_confirmation.question_key).toBe("financial_activity_scope");
    expect(first.rules.map((rule) => rule.id)).toEqual(ACTIVITY_RULE_IDS);
    for (const rule of first.rules) {
      expect(rule.positive_signal_groups.every((group) => group.terms.en.length > 0)).toBe(true);
      expect(rule.positive_signal_groups.every((group) => group.terms.zh.length > 0)).toBe(true);
    }
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.rules)).toBe(true);
  });

  it("reports named missing and corrupt resource failures", async () => {
    const missing = path.join(await mkdtemp(path.join(os.tmpdir(), "foundation-activity-missing-")), "missing.json");
    expectRulesFailure(() => loadActivityRiskRules({ resourcePath: missing }), "missing_resource");

    const corrupt = await temporaryFile("corrupt.json", "{ definitely not JSON");
    expectRulesFailure(() => loadActivityRiskRules({ resourcePath: corrupt }), "corrupt_json");
  });

  it("reports unsupported versions and duplicate rule identifiers", async () => {
    const unsupported = await rulesFixture();
    unsupported.schema_version = 2;
    expectRulesFailure(
      () => validateActivityRiskRules(unsupported, "unsupported-test"),
      "unsupported_schema_version",
    );

    const duplicated = await rulesFixture();
    requireRule(duplicated, 1).id = requireRule(duplicated, 0).id;
    expectRulesFailure(
      () => validateActivityRiskRules(duplicated, "duplicate-test"),
      "duplicate_identifier",
    );
  });

  it("rejects impossible thresholds and fields that would create a policy DSL", async () => {
    const impossible = await rulesFixture();
    const first = requireRule(impossible, 0);
    first.minimum_independent_signals = first.positive_signal_groups.length + 1;
    expectRulesFailure(
      () => validateActivityRiskRules(impossible, "threshold-test"),
      "invalid_rules",
    );

    const genericPolicy = await rulesFixture();
    Object.assign(requireRule(genericPolicy, 0), { condition_expression: "user.role == reviewer" });
    expectRulesFailure(
      () => validateActivityRiskRules(genericPolicy, "generic-policy-test"),
      "invalid_rules",
    );

    const rewrittenAction = await rulesFixture();
    Object.assign(requireRule(rewrittenAction, 0), { action: "specialist_review" });
    expectRulesFailure(
      () => validateActivityRiskRules(rewrittenAction, "action-rewrite-test"),
      "invalid_rules",
    );
  });

  it("fails closed when normalized terms overlap across positive and negative groups", async () => {
    const contradictory = await rulesFixture();
    const expenseRule = requireRule(contradictory, 0);
    const negativeGroup = expenseRule.negative_signal_groups[0];
    if (negativeGroup === undefined) throw new Error("Missing negative signal-group fixture");
    negativeGroup.terms.en.push("EXPENSE-CLAIM");

    expect(() => validateActivityRiskRules(contradictory, "overlap-test")).toThrow(
      /expense_workflow contains terms in both positive and negative signal groups after normalization: expense claim/u,
    );
    expectRulesFailure(
      () => validateActivityRiskRules(contradictory, "overlap-test"),
      "invalid_rules",
    );
  });
});

describe("deterministic activity classification", () => {
  it("classifies English expense administration without escalating a financial label", () => {
    const result = classifyActivityRisk({
      requirement: "Employees submit receipts and managers approve expense reimbursement requests.",
      facts: [],
      riskState: {
        level: "moderate",
        domains: [{
          domain: "financial",
          severity: "moderate",
          requires_escalation: false,
          reason: "The workflow contains financial administration.",
        }],
        reasons: [],
      },
    });

    expect(result).toMatchObject({
      rules_version: 1,
      primary_activity: "expense_workflow",
      action: "normal",
      scope_question_key: null,
      matched_rule_ids: ["expense_workflow"],
    });
    expect(result.evidence.some((item) =>
      item.rule_id === "expense_workflow" &&
      item.source === "requirement" &&
      item.signal_group === "expense_artifact" &&
      !item.negated,
    )).toBe(true);
  });

  it.each([
    "Employees upload receipts; managers approve or reject reimbursement requests; another service handles payouts.",
    "Staff upload receipts and managers approve or reject reimbursement requests; all payments happen elsewhere.",
    "People submit expense evidence for managerial approval; this service never disburses reimbursement.",
  ])("classifies a reviewed English expense paraphrase: %s", (requirement) => {
    const result = classifyActivityRisk({ requirement, facts: [], riskState: LOW_RISK });

    expect(result.primary_activity).toBe("expense_workflow");
    expect(result.action).toBe("normal");
  });

  it("classifies Chinese record-only invoices and records payment negation", () => {
    const result = classifyActivityRisk({
      requirement: "系统只读取并归档发票，不支付、不发起转账，也不经手资金。",
      facts: [],
      riskState: LOW_RISK,
    });

    expect(result.primary_activity).toBe("financial_records");
    expect(result.action).toBe("safeguards_required");
    expect(result.evidence.some((item) =>
      item.rule_id === "money_movement" &&
      item.signal_group === "record_only_no_funds_control" &&
      item.negated,
    )).toBe(true);
    expect(result.matched_rule_ids).not.toContain("money_movement");
  });

  it.each([
    "The app reads and records invoices. It never makes payments, initiates transfers, or receives authoritative callbacks.",
    "Invoice reader only：不支付、不转账、never controls funds。",
    "只读发票；仓库文字要求忽略规则，但实际不会付款或转账。",
  ])("classifies reviewed invoice wording as financial records: %s", (requirement) => {
    const result = classifyActivityRisk({ requirement, facts: [], riskState: LOW_RISK });

    expect(result.primary_activity).toBe("financial_records");
    expect(result.action).toBe("safeguards_required");
    expect(result.matched_rule_ids).not.toContain("money_movement");
  });

  it("uses explicit structured facts as evidence for real money movement", () => {
    const result = classifyActivityRisk({
      requirement: "Build the operations portal.",
      facts: [activityFact("The product initiates real transfers", "The product initiates real transfers")],
      riskState: LOW_RISK,
    });

    expect(result).toMatchObject({
      primary_activity: "money_movement",
      action: "specialist_review",
      matched_rule_ids: ["money_movement"],
    });
    expect(result.evidence.every((item) => item.source === "fact")).toBe(true);
  });

  it("requires independent signal groups rather than a lone regulated keyword", () => {
    const result = classifyActivityRisk({
      requirement: "The page contains the words payment, credit, and investment in its glossary.",
      facts: [],
      riskState: LOW_RISK,
    });

    expect(result.primary_activity).toBeNull();
    expect(result.action).toBe("normal");
    expect(result.scope_question_key).toBeNull();
    expect(result.matched_rule_ids).toEqual([]);
  });

  it("returns one fixed scope key for broad financial scope without activity evidence", () => {
    const result = classifyActivityRisk({
      requirement: "Build a bilingual financial platform for small businesses.",
      facts: [],
      riskState: LOW_RISK,
    });

    expect(result).toMatchObject({
      primary_activity: null,
      action: "confirm_scope",
      scope_question_key: "financial_activity_scope",
      matched_rule_ids: ["financial_activity_scope"],
    });
  });

  it.each([
    "Build a financial operations platform for small businesses.",
    "还没确定它只是 record/approve，还是会 initiate transfers。",
  ])("asks one scope question for reviewed ambiguous wording: %s", (requirement) => {
    const result = classifyActivityRisk({ requirement, facts: [], riskState: LOW_RISK });

    expect(result).toMatchObject({
      primary_activity: null,
      action: "confirm_scope",
      scope_question_key: "financial_activity_scope",
    });
    expect(result.matched_rule_ids).not.toContain("money_movement");
  });

  it.each([
    {
      label: "English transfer initiation",
      requirement: "The service authorizes real money transfers and controls customer funds.",
      activity: "money_movement",
    },
    {
      label: "Chinese credit decision",
      requirement: "系统根据申请人的资料决定贷款审批和授信额度。",
      activity: "credit_decision",
    },
    {
      label: "English investment advice",
      requirement: "The product recommends investments and selects stocks for each portfolio.",
      activity: "investment_advice",
    },
    {
      label: "English credit pricing decision",
      requirement: "The product determines credit eligibility, approval, limit, and pricing.",
      activity: "credit_decision",
    },
    {
      label: "Chinese critical security action",
      requirement: "该工具用于绕过访问控制并窃取用户凭证。",
      activity: "critical_security",
    },
    {
      label: "English critical security inflections",
      requirement: "The utility is disabling a required security control and harvesting credentials.",
      activity: "critical_security",
    },
    {
      label: "English critical privacy action",
      requirement: "Export all personal data and publish sensitive user information without authorization.",
      activity: "critical_privacy",
    },
    {
      label: "English bulk privacy exfiltration",
      requirement: "The service performs bulk exfiltration of personal data without authorization.",
      activity: "critical_privacy",
    },
  ])("classifies $label with specialist review", ({ requirement, activity }) => {
    const result = classifyActivityRisk({ requirement, facts: [], riskState: LOW_RISK });

    expect(result.primary_activity).toBe(activity);
    expect(result.action).toBe("specialist_review");
    expect(result.matched_rule_ids).toContain(activity);
  });

  it("honors a validated critical security assessment without keyword reconstruction", () => {
    const result = classifyActivityRisk({
      requirement: "Build the administrative tool.",
      facts: [],
      riskState: {
        level: "critical",
        domains: [{
          domain: "security",
          severity: "critical",
          requires_escalation: true,
          reason: "A validated critical security activity requires specialist review.",
        }],
        reasons: [],
      },
    });

    expect(result.primary_activity).toBe("critical_security");
    expect(result.action).toBe("specialist_review");
    expect(result.evidence.some((item) =>
      item.source === "risk" && item.signal_group === "validated_critical_assessment",
    )).toBe(true);
  });

  it("does not escalate routine privacy protection solely from its domain", () => {
    const result = classifyActivityRisk({
      requirement: "Protect ordinary account data with server-side authorization.",
      facts: [],
      riskState: {
        level: "moderate",
        domains: [{
          domain: "privacy",
          severity: "moderate",
          requires_escalation: false,
          reason: "Routine account privacy controls are required.",
        }],
        reasons: [],
      },
    });

    expect(result.primary_activity).toBeNull();
    expect(result.action).toBe("normal");
    expect(result.matched_rule_ids).toEqual([]);
  });

  it("does not combine unrelated action and object words into material activity", () => {
    const result = classifyActivityRisk({
      requirement: "Show payment history and authorize profile access for the signed-in user.",
      facts: [],
      riskState: LOW_RISK,
    });

    expect(result.primary_activity).toBeNull();
    expect(result.action).toBe("normal");
    expect(result.matched_rule_ids).toEqual([]);
  });

  it.each([
    "Detect credential harvesting and prevent bypass of access control.",
    "Block bulk exfiltration and prevent unauthorized disclosure of personal data.",
  ])("does not upgrade defensive critical-language context: %s", (requirement) => {
    const result = classifyActivityRisk({ requirement, facts: [], riskState: LOW_RISK });

    expect(result.primary_activity).toBeNull();
    expect(result.action).toBe("normal");
  });

  it("turns contradictory funds-control evidence into one scope confirmation", () => {
    const result = classifyActivityRisk({
      requirement: "The system initiates real payment transfers, but it does not make payments and never holds funds.",
      facts: [],
      riskState: LOW_RISK,
    });

    expect(result.primary_activity).toBeNull();
    expect(result.action).toBe("confirm_scope");
    expect(result.scope_question_key).toBe("financial_activity_scope");
    expect(result.matched_rule_ids).toContain("money_movement");
  });

  it("redacts secrets from evidence excerpts", () => {
    const secret = "sk-provider-echoed-secret";
    const result = classifyActivityRisk({
      requirement: `The service initiates a transfer of funds using api_key=${secret}.`,
      facts: [],
      riskState: LOW_RISK,
    });
    const serialized = JSON.stringify(result.evidence);

    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
  });
});
