import { describe, expect, it, vi } from "vitest";

import {
  assertRegressionInventoryReleaseCoverage,
  createRegressionInventoryCoverageReport,
  loadRegressionInventoryDirectory,
  runRegressionInventory,
} from "../../src/regression-inventory.js";
import {
  createProductionRegressionExecutor,
  executeProductionRegressionCase,
} from "../../src/regression-inventory-executor.js";

describe("offline regression inventory runner", () => {
  it("passes the release floor and every required category without a credential", async () => {
    const priorCredential = process.env.FOUNDATION_LLM_API_KEY;
    delete process.env.FOUNDATION_LLM_API_KEY;
    try {
      const inventory = await loadRegressionInventoryDirectory();
      const coverage = createRegressionInventoryCoverageReport(inventory);
      expect(() => assertRegressionInventoryReleaseCoverage(coverage)).not.toThrow();
      expect(coverage).toMatchObject({
        reviewed_family_count: 36,
        derived_variant_count: 8,
        total_case_count: 44,
        release_floor: 30,
        release_floor_met: true,
        missing_required_categories: [],
        claim_scope: "maintainer_reviewed_known_regressions",
      });
      expect(coverage.statement).toContain("not a representative benchmark");
      expect(JSON.stringify(coverage)).not.toMatch(/general accuracy|accuracy percentage|universal accuracy/iu);
    } finally {
      if (priorCredential === undefined) delete process.env.FOUNDATION_LLM_API_KEY;
      else process.env.FOUNDATION_LLM_API_KEY = priorCredential;
    }
  });

  it("executes all checked-in cases through production deterministic adapters without network access", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network access is forbidden in the offline inventory"));
    const inventory = await loadRegressionInventoryDirectory();
    try {
      const report = await runRegressionInventory(inventory, createProductionRegressionExecutor());

      expect(report.executed_case_count).toBe(44);
      expect(report.failed_case_count).toBe(0);
      expect(report.passed_case_count).toBe(44);
      expect(report.results.every((result) => result.passed)).toBe(true);
      const promptInjection = report.results.filter((result) =>
        result.family_id === "repository_prompt_injection_payment"
      );
      expect(promptInjection).toHaveLength(2);
      expect(promptInjection.every((result) => result.passed)).toBe(true);
      const promptInjectionCases = inventory.cases.filter((regressionCase) =>
        regressionCase.input.kind === "activity" &&
        regressionCase.input.repository_context !== undefined
      );
      expect(promptInjectionCases.map((regressionCase) =>
        regressionCase.input.kind === "activity"
          ? regressionCase.input.repository_context?.kind
          : undefined
      )).toEqual(["summary", "diff"]);
      for (const regressionCase of promptInjectionCases) {
        const observation = await executeProductionRegressionCase(regressionCase);
        expect(observation.trace_ids).toContain("untrusted_instruction_ignored");
      }
      expect(report.statement).toContain("do not measure general");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("fails the release check with the exact missing floor and categories", () => {
    expect(() => assertRegressionInventoryReleaseCoverage({
      schema_version: 1,
      reviewed_family_count: 1,
      derived_variant_count: 0,
      total_case_count: 1,
      release_floor: 30,
      release_floor_met: false,
      category_coverage: Object.fromEntries([]) as never,
      missing_required_categories: ["critical_security", "prompt_injection"],
      original_language_coverage: { en: 1, zh: 0, mixed: 0 },
      derived_language_coverage: { en: 0, zh: 0, mixed: 0 },
      transformation_coverage: { paraphrase: 0, translation: 0, negation: 0, permutation: 0, material_flip: 0, prompt_injection: 0 },
      claim_scope: "maintainer_reviewed_known_regressions",
      statement: "Narrow fixture inventory.",
    })).toThrow(/reviewed family count 1 is below release floor 30; missing required categories: critical_security, prompt_injection/u);
  });
});
