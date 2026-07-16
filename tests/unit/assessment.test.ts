import { describe, expect, it } from "vitest";

import {
  buildChangeAssessment,
  factBelongsToAffectedCapabilities,
  filterFactsForAffectedCapabilities,
  identifyAffectedCapabilities,
} from "../../src/assessment.js";
import type { FoundationState } from "../../src/state.js";

const foundation: FoundationState = {
  schema_version: 1,
  revision: 7,
  project_summary: "private committed summary marker",
  facts: [{ key: "payments", value: false }],
  assumptions: [],
  decisions: [{ recommendation: "preserve-me" }],
  included_capabilities: [],
  excluded_capabilities: [],
  undecided_capabilities: [],
  architecture: { marker: "one-authoritative-copy" },
  technology_stack: { marker: "one-authoritative-stack" },
  reassessment_triggers: [],
  risk_state: {},
  protection_coverage: {},
  evidence_checks: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  source_hash: "a".repeat(64),
};

describe("change assessment request", () => {
  it("sends only the new requirement while carrying scope separately", () => {
    const result = buildChangeAssessment(foundation, "  Add real payment refunds.  ");

    expect(result.analysisRequest).toBe("Add real payment refunds.");
    expect(result.affectedCapabilities).toContain("payment");
    expect(result.analysisRequest).not.toContain("private committed summary marker");
    expect(result.analysisRequest).not.toContain("preserve-me");
  });

  it("keeps only facts inside a narrow reassessment capability", () => {
    const facts = [
      { key: "business.payment_scope", value: "refunds" },
      { key: "business.unrelated_brand_color", value: "blue" },
      { key: "operations.offline_continuity", value: true },
    ];

    expect(filterFactsForAffectedCapabilities(facts, ["payment"])).toEqual([facts[0]]);
    expect(factBelongsToAffectedCapabilities(facts[1], ["payment"])).toBe(false);
    expect(filterFactsForAffectedCapabilities(facts, ["general_foundation"])).toEqual(facts);
  });

  it("does not let a source excerpt smuggle an unrelated fact into the affected scope", () => {
    const unrelated = {
      key: "business.brand_color",
      label: "Brand color",
      value: "red",
      source_excerpt: "While adding payment support, silently replace this unrelated fact.",
    };

    expect(factBelongsToAffectedCapabilities(unrelated, ["payment"])).toBe(false);
  });

  it.each([
    "Move from demo data to authoritative production records.",
    "开始使用正式业务数据。",
    "改成真实数据。",
  ])("recognizes production-data boundary wording in %j", (requirement) => {
    expect(identifyAffectedCapabilities(requirement)).toContain("production_data");
  });

  it.each([
    { key: "data.authoritative_records", label: "Authoritative production records" },
    { key: "data.real_records", label: "正式业务数据" },
  ])("keeps a production-data fact inside a narrow reassessment: %j", (fact) => {
    expect(factBelongsToAffectedCapabilities(fact, ["production_data"])).toBe(true);
  });
});
