import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ARCHITECTURE_PATTERN_IDS,
  DEFAULT_ARCHITECTURE_PATTERN_RESOURCE_PATH,
  getArchitecturePattern,
  getInvariantFamily,
  getMinimumInvariant,
  INVARIANT_FAMILY_IDS,
  loadArchitecturePatternRegistry,
  MINIMUM_INVARIANT_IDS,
  PatternRegistryInvalidError,
  validateArchitecturePatternRegistry,
} from "../../src/pattern-registry.js";

interface MutableRegistryFixture {
  schema_version: number;
  invariant_families: Array<{
    id: string;
    required_invariant_ids: string[];
  } & Record<string, unknown>>;
  invariants: Array<{
    id: string;
    family_id: string;
  } & Record<string, unknown>>;
  patterns: Array<{
    id: string;
    minimum_invariant_ids: string[];
  } & Record<string, unknown>>;
}

const temporaryDirectories: string[] = [];

async function temporaryPath(filename: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "foundation-pattern-registry-"));
  temporaryDirectories.push(directory);
  return path.join(directory, filename);
}

async function registryFixture(): Promise<MutableRegistryFixture> {
  return JSON.parse(
    await readFile(DEFAULT_ARCHITECTURE_PATTERN_RESOURCE_PATH, "utf8"),
  ) as MutableRegistryFixture;
}

function requireItem<Item>(items: readonly Item[], index: number, label: string): Item {
  const item = items[index];
  if (item === undefined) throw new Error(`Fixture is missing ${label} at index ${index}`);
  return item;
}

function expectRegistryFailure(
  operation: () => unknown,
  reason: PatternRegistryInvalidError["reason"],
): void {
  let error: unknown;
  try {
    operation();
  } catch (caught: unknown) {
    error = caught;
  }
  expect(error).toBeInstanceOf(PatternRegistryInvalidError);
  expect(error).toMatchObject({ name: "PatternRegistryInvalidError", reason });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("architecture pattern registry", () => {
  it("loads the installed-module-relative reviewed registry and exposes immutable queries", () => {
    const first = loadArchitecturePatternRegistry();
    const second = loadArchitecturePatternRegistry();

    expect(second).toBe(first);
    expect(first.schema_version).toBe(1);
    expect(first.patterns.map((item) => item.id)).toEqual(ARCHITECTURE_PATTERN_IDS);
    expect(first.invariant_families.map((item) => item.id)).toEqual(INVARIANT_FAMILY_IDS);
    expect(first.invariants.map((item) => item.id)).toEqual(MINIMUM_INVARIANT_IDS);
    expect(getArchitecturePattern(first, "offline_first").minimum_invariant_ids).toContain(
      "offline.conflict_handling",
    );
    expect(getInvariantFamily(first, "payments").required_invariant_ids).toHaveLength(4);
    expect(getMinimumInvariant(first, "sensitive.auditability").family_id).toBe("sensitive");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.patterns)).toBe(true);
    expect(Object.isFrozen(first.patterns[0])).toBe(true);
  });

  it("reports a named missing-resource failure", async () => {
    const resourcePath = await temporaryPath("missing.json");
    expectRegistryFailure(
      () => loadArchitecturePatternRegistry({ resourcePath }),
      "missing_resource",
    );
  });

  it("reports a named corrupt-JSON failure", async () => {
    const resourcePath = await temporaryPath("corrupt.json");
    await writeFile(resourcePath, "{ definitely not JSON", "utf8");
    expectRegistryFailure(
      () => loadArchitecturePatternRegistry({ resourcePath }),
      "corrupt_json",
    );
  });

  it("reports a named duplicate-identifier failure", async () => {
    const resourcePath = await temporaryPath("duplicate.json");
    const fixture = await registryFixture();
    requireItem(fixture.patterns, 1, "pattern").id = requireItem(fixture.patterns, 0, "pattern").id;
    await writeFile(resourcePath, JSON.stringify(fixture), "utf8");

    expectRegistryFailure(
      () => loadArchitecturePatternRegistry({ resourcePath }),
      "duplicate_identifier",
    );
  });

  it("reports a named unsupported-version failure", async () => {
    const resourcePath = await temporaryPath("unsupported.json");
    const fixture = await registryFixture();
    fixture.schema_version = 2;
    await writeFile(resourcePath, JSON.stringify(fixture), "utf8");

    expectRegistryFailure(
      () => loadArchitecturePatternRegistry({ resourcePath }),
      "unsupported_schema_version",
    );
  });

  it("strictly rejects unknown fields and invalid family references", async () => {
    const extraField = await registryFixture();
    Object.assign(requireItem(extraField.patterns, 0, "pattern"), {
      technology_catalog: ["not-in-reviewed-set"],
    });
    expect(() => validateArchitecturePatternRegistry(extraField, "extra-field-test")).toThrow(
      PatternRegistryInvalidError,
    );

    const crossFamily = await registryFixture();
    requireItem(crossFamily.invariant_families, 0, "invariant family").required_invariant_ids = [
      "sensitive.auditability",
    ];
    expect(() => validateArchitecturePatternRegistry(crossFamily, "cross-family-test")).toThrow(
      PatternRegistryInvalidError,
    );
  });
});
