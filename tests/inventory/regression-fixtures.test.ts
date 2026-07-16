import { describe, expect, it } from "vitest";

import {
  createRegressionInventoryCoverageReport,
  loadRegressionInventoryDirectory,
} from "../../src/regression-inventory.js";

describe("checked-in regression fixtures", () => {
  it("contains every directly reproduced defect as an original reviewed family", async () => {
    const inventory = await loadRegressionInventoryDirectory();
    const familyIds = new Set(inventory.families.map((family) => family.id));
    const reproducedDefects = [
      "doctor_missing_credential",
      "doctor_missing_probe",
      "ordinary_expense_not_specialist",
      "critical_security_requires_review",
      "critical_privacy_requires_review",
      "eliminated_recommendation_no_positional_fallback",
      "three_route_ambiguity_abstains",
    ];
    for (const familyId of reproducedDefects) expect(familyIds.has(familyId), familyId).toBe(true);
    for (const familyId of familyIds) {
      const family = inventory.families.find((candidate) => candidate.id === familyId);
      expect(family?.cases.filter((regressionCase) => regressionCase.provenance === "original")).toHaveLength(1);
    }
  });

  it("contains reviewed positive and negative risk/pattern boundaries", async () => {
    const inventory = await loadRegressionInventoryDirectory();
    const report = createRegressionInventoryCoverageReport(inventory);
    const requiredBoundaries = [
      "ordinary_expense_workflow",
      "financial_records_without_funds_control",
      "invoice_payment_negation",
      "actual_money_movement",
      "credit_decision",
      "investment_advice",
      "offline_continuity",
      "multi_organization_isolation",
      "static_demo_production_records",
      "real_payments",
      "sensitive_data",
    ] as const;
    for (const category of requiredBoundaries) {
      expect(report.category_coverage[category], category).toBeGreaterThan(0);
    }
    expect(inventory.families).toHaveLength(36);
    expect(inventory.cases.filter((regressionCase) => regressionCase.provenance === "original")).toHaveLength(36);
  });

  it("links each required derived transformation without inflating reviewed-family count", async () => {
    const inventory = await loadRegressionInventoryDirectory();
    const report = createRegressionInventoryCoverageReport(inventory);

    expect(report.reviewed_family_count).toBe(36);
    expect(report.derived_variant_count).toBe(8);
    expect(report.total_case_count).toBe(44);
    expect(report.derived_language_coverage.zh).toBeGreaterThan(0);
    expect(report.derived_language_coverage.en).toBeGreaterThan(0);
    expect(report.derived_language_coverage.mixed).toBeGreaterThan(0);
    for (const transformation of [
      "paraphrase",
      "translation",
      "negation",
      "material_flip",
      "prompt_injection",
      "permutation",
    ] as const) {
      expect(report.transformation_coverage[transformation], transformation).toBeGreaterThan(0);
    }
    for (const regressionCase of inventory.cases) {
      if (regressionCase.provenance !== "derived") continue;
      expect(inventory.families.some((family) => family.id === regressionCase.source_family_id)).toBe(true);
      expect(regressionCase.material_input_assertions.length).toBeGreaterThan(0);
    }
  });
});
