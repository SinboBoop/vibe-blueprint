#!/usr/bin/env node
import {
  assertRegressionInventoryReleaseCoverage,
  createRegressionInventoryCoverageReport,
  loadRegressionInventoryDirectory,
  runRegressionInventory,
} from "./regression-inventory.js";
import { createProductionRegressionExecutor } from "./regression-inventory-executor.js";
import { safeErrorMessage } from "./security.js";

class RegressionInventoryExecutionError extends Error {
  override readonly name = "RegressionInventoryExecutionError";
}

async function main(): Promise<void> {
  const inventory = await loadRegressionInventoryDirectory();
  const coverage = createRegressionInventoryCoverageReport(inventory);
  assertRegressionInventoryReleaseCoverage(coverage);
  const execution = await runRegressionInventory(
    inventory,
    createProductionRegressionExecutor(),
  );
  if (execution.failed_case_count > 0) {
    const failures = execution.results
      .filter((result) => !result.passed)
      .map((result) => `${result.family_id}/${result.case_id}: ${result.mismatches.join("; ")}`);
    throw new RegressionInventoryExecutionError(
      `${execution.failed_case_count} production regression case(s) failed: ${failures.join(" | ")}`,
    );
  }
  process.stdout.write(`${JSON.stringify({
    status: "pass",
    check: "regression_inventory_contract_coverage_and_production_execution",
    coverage,
    execution,
  }, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
