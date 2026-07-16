import { describe, expect, it } from "vitest";

import { FoundationAnalysisService } from "../../src/analysis-service.js";
import { InMemoryAnalysisStore } from "../../src/analysis-store.js";
import {
  detectFoundationBoundaryRisks,
  enforceFoundationBoundaryRisks,
} from "../../src/foundation-boundary-risk.js";
import type { FoundationModelClient } from "../../src/model-client.js";
import type { RiskState } from "../../src/schemas.js";
import { analysis, fact, lowRisk, route } from "../helpers/model-fixtures.js";

const highFinancialRisk: RiskState = {
  level: "high",
  domains: [{
    domain: "financial",
    severity: "high",
    requires_escalation: false,
    reason: "Existing high financial-record handling risk.",
  }],
  reasons: ["Existing high financial-record handling risk."],
};

describe("deterministic Foundation boundary risks", () => {
  it.each([
    ["The product diagnoses patient conditions and recommends treatment.", "medical"],
    ["系统根据患者症状作出临床诊断并推荐治疗方案。", "medical"],
    ["The system selects medication dosage and recommends the next care pathway for each patient.", "medical"],
    ["系统会根据症状分诊，并给患者推荐下一步就医方案。", "medical"],
    ["The app stores children's personal data and tracks child locations.", "children_data"],
    ["The app stores children's dates of birth and school identifiers.", "children_data"],
    ["系统收集未成年人个人信息并分析儿童画像。", "children_data"],
    ["The product must determine and certify HIPAA compliance across every workflow.", "complex_compliance"],
    ["系统需要自动判定跨境数据合规，并保证满足监管认证。", "complex_compliance"],
    ["Build firmware for a safety-critical hard real-time flight-control system.", "capability_boundary"],
    ["请开发嵌入式固件和安全关键实时飞行控制系统。", "capability_boundary"],
    ["Create a native-only iOS mobile app with no Web product.", "capability_boundary"],
    ["Build a SwiftUI iPhone app with no Web component.", "capability_boundary"],
    ["Create a native desktop app for Windows with no Web app.", "capability_boundary"],
    ["请构建一套游戏引擎。", "capability_boundary"],
  ] as const)("detects %s as %s", (requirement, domain) => {
    expect(detectFoundationBoundaryRisks({ requirement, facts: [] })).toContainEqual(
      expect.objectContaining({
        domain,
        severity: "critical",
        requires_escalation: true,
      }),
    );
  });

  it("uses validated facts as evidence", () => {
    const detected = detectFoundationBoundaryRisks({
      requirement: "Build the product.",
      facts: [fact({
        id: "clinical_scope",
        key: "scope.clinical_decision",
        label: "Clinical decision scope",
        value: "Recommends treatment for patients",
        certainty: "explicit",
        question: null,
        source_excerpt: "The service recommends treatment for patients.",
      })],
    });

    expect(detected.map((assessment) => assessment.domain)).toContain("medical");
  });

  it.each([
    "Build an employee health-clinic scheduling web app; it does not diagnose patients or recommend treatment.",
    "建立健康排班系统，不诊断疾病，也不提供治疗建议。",
    "The app is for adults only and does not collect children's personal data.",
    "The app is for adults and isn't collecting children's personal data.",
    "系统不收集儿童个人信息，只处理成年员工账号。",
    "Build a normal web expense approval app.",
    "Create a Web dashboard that displays game-engine build status.",
    "Build a health scheduler, not a clinical diagnosis or treatment recommendation system.",
    "Build a records app that stores existing patient diagnoses but never diagnoses or recommends treatment.",
    "It is not yet decided whether the scheduler may diagnose patients.",
    "尚未确定是否会诊断患者，目前只做排班。",
    "Build a Web simulator, not firmware or an embedded system.",
    "The privacy page documents GDPR requirements; it does not determine or guarantee compliance.",
  ])("does not upgrade a negative or ordinary case: %s", (requirement) => {
    expect(detectFoundationBoundaryRisks({ requirement, facts: [] })).toEqual([]);
  });

  it("ignores a false or unknown fact as positive evidence", () => {
    const risks = detectFoundationBoundaryRisks({
      requirement: "Build an ordinary account app.",
      facts: [
        fact({
          id: "child_data_false",
          key: "data.children",
          label: "Stores children's personal data",
          value: false,
          certainty: "explicit",
          question: null,
        }),
        fact({
          id: "clinical_unknown",
          key: "scope.clinical",
          label: "Recommends treatment to patients",
          value: null,
          certainty: "unknown_critical",
        }),
      ],
    });

    expect(risks).toEqual([]);
  });

  it("adds missing critical domains without lowering or deleting existing risk", () => {
    const merged = enforceFoundationBoundaryRisks(
      "The app stores children's personal data.",
      [],
      highFinancialRisk,
    );

    expect(merged.level).toBe("critical");
    expect(merged.domains).toContainEqual(highFinancialRisk.domains[0]);
    expect(merged.domains).toContainEqual(expect.objectContaining({
      domain: "children_data",
      severity: "critical",
      requires_escalation: true,
    }));
  });

  it("upgrades a weak same-domain model assessment instead of duplicating it", () => {
    const merged = enforceFoundationBoundaryRisks(
      "The product diagnoses patients and recommends treatment.",
      [],
      {
        level: "moderate",
        domains: [{
          domain: "medical",
          severity: "moderate",
          requires_escalation: false,
          reason: "The model noticed a general health context.",
        }],
        reasons: [],
      },
    );

    expect(merged.domains).toHaveLength(1);
    expect(merged.domains[0]).toMatchObject({
      domain: "medical",
      severity: "critical",
      requires_escalation: true,
    });
  });

  it("keeps the merged risk state within the schema domain limit", () => {
    const existing: RiskState = {
      level: "low",
      domains: Array.from({ length: 20 }, (_, index) => ({
        domain: "general" as const,
        severity: "low" as const,
        requires_escalation: false,
        reason: `Placeholder ${index}`,
      })),
      reasons: [],
    };

    const merged = enforceFoundationBoundaryRisks(
      "The product diagnoses patients and recommends treatment.",
      [],
      existing,
    );
    expect(merged.domains.length).toBeLessThanOrEqual(20);
    expect(merged.domains).toContainEqual(expect.objectContaining({ domain: "medical" }));
  });

  it("integrates before decision and persistence so a model miss cannot silently decide", async () => {
    const store = new InMemoryAnalysisStore();
    const modelClient: FoundationModelClient = {
      analyze: () => Promise.resolve(analysis([route("managed_online")], { risk_state: lowRisk })),
    };
    const service = new FoundationAnalysisService({ modelClient, store });
    const decision = await service.analyze({
      request: "Build a system that diagnoses patient conditions and recommends treatment.",
      projectRoot: "/test",
    });

    expect(decision.interaction_mode).toBe("escalate");
    expect(decision.risk_state.domains).toContainEqual(expect.objectContaining({
      domain: "medical",
      requires_escalation: true,
    }));
    const stored = await store.get(decision.analysis_id);
    expect(stored?.modelAnalysis.risk_state).toEqual(decision.risk_state);
  });
});
