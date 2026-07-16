import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  InventoryCaseInvalidError,
  loadRegressionInventoryFiles,
  RegressionInventoryDocumentSchema,
  runRegressionInventory,
  type RegressionInventoryDocument,
  type RegressionObservation,
} from "../../src/regression-inventory.js";

function expected(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { interaction_modes: ["decide"], permitted_route_ids: ["managed"], ...overrides };
}

function routeInput(): Record<string, unknown> {
  return {
    kind: "route_resolution",
    routes: [{
      id: "managed",
      pattern: "managed_modular_monolith",
      consequence_group: "normal_launch",
      satisfies_hard_constraints: true,
      dominated: false,
      business_owned: false,
      durable_tradeoff: false,
    }],
    recommended_route_id: "managed",
    critical_question_key: null,
  };
}

function preservedRouteAssertions(): readonly Record<string, unknown>[] {
  return [
    { id: "routes_preserved", source_path: "/routes", relationship: "preserved", comparison: "unordered_array" },
    { id: "recommendation_preserved", source_path: "/recommended_route_id", relationship: "preserved", comparison: "exact" },
    { id: "question_preserved", source_path: "/critical_question_key", relationship: "preserved", comparison: "exact" },
  ];
}

function originalCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "case_original",
    provenance: "original",
    language: "en",
    requirement: "Build a normal managed web application.",
    input: routeInput(),
    expected: expected(),
    ...overrides,
  };
}

function rawDocument(families?: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    schema_version: 1,
    families: families ?? [{
      id: "family_one",
      title: "One reviewed boundary",
      review_status: "maintainer_reviewed",
      language: "en",
      categories: ["false_choices"],
      rationale: "Protects a known deterministic route boundary.",
      cases: [originalCase()],
    }],
  };
}

function document(families?: readonly Record<string, unknown>[]): RegressionInventoryDocument {
  return RegressionInventoryDocumentSchema.parse(rawDocument(families));
}

async function fixtureFile(name: string, value: unknown): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "foundation-inventory-"));
  const file = path.join(directory, name);
  await writeFile(file, JSON.stringify(value), "utf8");
  return file;
}

function observation(overrides: Partial<RegressionObservation> = {}): RegressionObservation {
  return {
    interaction_mode: "decide",
    activity_subtype: null,
    activity_action: null,
    selected_route_id: "managed",
    offered_route_ids: [],
    pattern_id: "managed_modular_monolith",
    question_key: null,
    abstention_reason: null,
    doctor: null,
    elimination_reasons: [],
    invariant_ids: [],
    trace_ids: [],
    ...overrides,
  };
}

describe("regression inventory contract", () => {
  it("loads one strict reviewed family with a linked invariant-preserving variant", async () => {
    const source = originalCase();
    const variant = {
      ...source,
      id: "case_translation",
      provenance: "derived",
      source_family_id: "family_one",
      transformation: "translation",
      material_input_assertions: preservedRouteAssertions(),
      language: "zh",
      requirement: "构建一个普通的托管式网页应用。",
    };
    const file = await fixtureFile("valid.json", document([{
      id: "family_one",
      title: "One reviewed boundary",
      review_status: "maintainer_reviewed",
      language: "en",
      categories: ["false_choices"],
      rationale: "Protects a known deterministic route boundary.",
      cases: [source, variant],
    }]));

    const loaded = await loadRegressionInventoryFiles([file]);
    expect(loaded.families).toHaveLength(1);
    expect(loaded.cases).toHaveLength(2);
  });

  it("rejects an unsupported schema version with file and exact field", async () => {
    const file = await fixtureFile("unsupported.json", { ...document(), schema_version: 2 });
    await expect(loadRegressionInventoryFiles([file])).rejects.toMatchObject({
      name: "InventoryCaseInvalidError",
      diagnostic: {
        file,
        family: null,
        case: null,
        field: "schema_version",
      },
    });
  });

  it("rejects unknown transformations with file, family, case, and field", async () => {
    const raw = JSON.parse(JSON.stringify(document())) as { families: Array<{ cases: unknown[] }> };
    raw.families[0]?.cases.push({
      ...originalCase(),
      id: "unknown_transform",
      provenance: "derived",
      source_family_id: "family_one",
      transformation: "shuffle_words",
      material_input_assertions: preservedRouteAssertions(),
    });
    const file = await fixtureFile("unknown-transform.json", raw);

    await expect(loadRegressionInventoryFiles([file])).rejects.toMatchObject({
      diagnostic: {
        file,
        family: "family_one",
        case: "unknown_transform",
        field: "families.0.cases.1.transformation",
      },
    });
  });

  it("rejects duplicate family and case IDs across files with exact ownership", async () => {
    const first = await fixtureFile("first.json", document());
    const second = await fixtureFile("second.json", document());
    await expect(loadRegressionInventoryFiles([first, second])).rejects.toThrow(/duplicate family id/u);

    const duplicateCase = document([{
      id: "family_two",
      title: "Second family",
      review_status: "maintainer_reviewed",
      language: "en",
      categories: ["false_choices"],
      rationale: "Exercises global case uniqueness.",
      cases: [originalCase()],
    }]);
    const third = await fixtureFile("third.json", duplicateCase);
    await expect(loadRegressionInventoryFiles([first, third])).rejects.toThrow(/duplicate case id/u);
  });

  it("rejects a derived case that references an unknown family", async () => {
    const source = originalCase();
    const file = await fixtureFile("bad-reference.json", document([{
      id: "family_one",
      title: "One reviewed boundary",
      review_status: "maintainer_reviewed",
      language: "en",
      categories: ["false_choices"],
      rationale: "Protects a known deterministic route boundary.",
      cases: [source, {
        ...source,
        id: "case_bad_reference",
        provenance: "derived",
        source_family_id: "missing_family",
        transformation: "paraphrase",
        material_input_assertions: preservedRouteAssertions(),
      }],
    }]));

    await expect(loadRegressionInventoryFiles([file])).rejects.toMatchObject({
      diagnostic: {
        file,
        family: "family_one",
        case: "case_bad_reference",
        field: "source_family_id",
      },
    });
  });

  it("requires material flips to declare and match changed expectations", async () => {
    const source = originalCase();
    const file = await fixtureFile("bad-flip.json", rawDocument([{
      id: "family_one",
      title: "One reviewed boundary",
      review_status: "maintainer_reviewed",
      language: "en",
      categories: ["material_fact_flips"],
      rationale: "Protects counterfactual expectation changes.",
      cases: [source, {
        ...source,
        id: "case_bad_flip",
        provenance: "derived",
        source_family_id: "family_one",
        transformation: "material_flip",
        material_input_assertions: [
          { id: "routes_flipped", source_path: "/routes", relationship: "flipped", comparison: "exact" },
          ...preservedRouteAssertions().slice(1),
        ],
      }],
    }]));

    await expect(loadRegressionInventoryFiles([file])).rejects.toThrow(/material_changes/u);
  });

  it("rejects a derived case that silently drops a declared material input fact", async () => {
    const source = originalCase();
    const changedInput = routeInput() as { routes: Array<Record<string, unknown>> };
    changedInput.routes[0] = { ...(changedInput.routes[0] ?? {}), satisfies_hard_constraints: false };
    const file = await fixtureFile("dropped-material-input.json", rawDocument([{
      id: "family_one",
      title: "One reviewed boundary",
      review_status: "maintainer_reviewed",
      language: "en",
      categories: ["candidate_permutations"],
      rationale: "A permutation must retain every material route fact.",
      cases: [source, {
        ...source,
        id: "case_bad_permutation",
        provenance: "derived",
        source_family_id: "family_one",
        transformation: "permutation",
        input: changedInput,
        material_input_assertions: preservedRouteAssertions(),
      }],
    }]));

    await expect(loadRegressionInventoryFiles([file])).rejects.toThrow(
      /declared preserved input changed/u,
    );
  });

  it("requires derived cases to declare every material input surface for their input kind", async () => {
    const source = originalCase();
    const file = await fixtureFile("missing-material-input.json", rawDocument([{
      id: "family_one",
      title: "One reviewed boundary",
      review_status: "maintainer_reviewed",
      language: "en",
      categories: ["false_choices"],
      rationale: "A derived oracle cannot leave recommendation material undeclared.",
      cases: [source, {
        ...source,
        id: "case_missing_assertion",
        provenance: "derived",
        source_family_id: "family_one",
        transformation: "paraphrase",
        material_input_assertions: [preservedRouteAssertions()[0]],
      }],
    }]));

    await expect(loadRegressionInventoryFiles([file])).rejects.toThrow(
      /must declare the material source input path \/recommended_route_id/u,
    );
  });

  it("requires a material flip to declare an actually changed material input", async () => {
    const source = originalCase();
    const file = await fixtureFile("unchanged-material-flip.json", rawDocument([{
      id: "family_one",
      title: "One reviewed boundary",
      review_status: "maintainer_reviewed",
      language: "en",
      categories: ["material_fact_flips"],
      rationale: "A material flip must be grounded in changed input, not only a changed oracle.",
      cases: [source, {
        ...source,
        id: "case_unchanged_flip",
        provenance: "derived",
        source_family_id: "family_one",
        transformation: "material_flip",
        expected: expected({ interaction_modes: ["abstain"], abstention_reason: "no_feasible_route" }),
        material_changes: [{ field: "interaction_modes", from: '["decide"]', to: '["abstain"]' }],
        material_input_assertions: [
          { id: "routes_flipped", source_path: "/routes", relationship: "flipped", comparison: "exact" },
          ...preservedRouteAssertions().slice(1),
        ],
      }],
    }]));

    await expect(loadRegressionInventoryFiles([file])).rejects.toThrow(
      /declared flipped input did not change/u,
    );
  });

  it("reports exact expectation mismatches without computing an accuracy percentage", async () => {
    const file = await fixtureFile("runner.json", document());
    const loaded = await loadRegressionInventoryFiles([file]);
    const report = await runRegressionInventory(loaded, {
      execute: () => observation({ selected_route_id: "wrong_route" }),
    });

    expect(report).toMatchObject({ executed_case_count: 1, passed_case_count: 0, failed_case_count: 1 });
    expect(report.results[0]?.mismatches).toContain("observed route set is outside permitted_route_ids");
    expect(JSON.stringify(report)).not.toMatch(/accuracy|percentage|percent/iu);
  });

  it("exposes a stable named loader error", () => {
    expect(new InventoryCaseInvalidError({
      file: "fixture.json",
      family: "family",
      case: "case",
      field: "expected",
      reason: "missing",
    }).message).toBe("Invalid regression inventory: file=fixture.json; family=family; case=case; field=expected; missing");
  });
});
