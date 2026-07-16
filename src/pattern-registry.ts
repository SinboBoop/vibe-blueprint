import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  MINIMUM_INVARIANT_IDS,
  type MinimumInvariantFamilyId,
  type MinimumInvariantId,
} from "./invariant-ids.js";

export { MINIMUM_INVARIANT_IDS } from "./invariant-ids.js";
export type { MinimumInvariantId } from "./invariant-ids.js";

export const ARCHITECTURE_PATTERN_IDS = [
  "static_demo",
  "managed_modular_monolith",
  "separated_api_monolith",
  "self_hosted_modular_monolith",
  "offline_first",
] as const;

export const INVARIANT_FAMILY_IDS = [
  "production",
  "offline",
  "multi_org",
  "payments",
  "sensitive",
] as const satisfies readonly MinimumInvariantFamilyId[];

export type ArchitecturePatternId = (typeof ARCHITECTURE_PATTERN_IDS)[number];
export type InvariantFamilyId = (typeof INVARIANT_FAMILY_IDS)[number];

const ArchitecturePatternIdSchema = z.enum(ARCHITECTURE_PATTERN_IDS);
const InvariantFamilyIdSchema = z.enum(INVARIANT_FAMILY_IDS);
const MinimumInvariantIdSchema = z.enum(MINIMUM_INVARIANT_IDS);

const PatternRegistryDocumentSchema = z
  .object({
    schema_version: z.literal(1),
    invariant_families: z
      .array(
        z
          .object({
            id: InvariantFamilyIdSchema,
            name: z.string().min(1).max(200),
            applies_when: z.string().min(1).max(500),
            required_pattern_ids: z.array(ArchitecturePatternIdSchema).max(5),
            incompatible_pattern_ids: z.array(ArchitecturePatternIdSchema).max(5),
            required_invariant_ids: z.array(MinimumInvariantIdSchema).min(1).max(15),
          })
          .strict(),
      )
      .length(INVARIANT_FAMILY_IDS.length),
    invariants: z
      .array(
        z
          .object({
            id: MinimumInvariantIdSchema,
            family_id: InvariantFamilyIdSchema,
            name: z.string().min(1).max(200),
            description: z.string().min(1).max(800),
          })
          .strict(),
      )
      .length(MINIMUM_INVARIANT_IDS.length),
    patterns: z
      .array(
        z
          .object({
            id: ArchitecturePatternIdSchema,
            name: z.string().min(1).max(200),
            fit: z.string().min(1).max(800),
            shape: z.string().min(1).max(800),
            hard_limits: z.array(z.string().min(1).max(800)).min(1).max(10),
            minimum_invariant_ids: z.array(MinimumInvariantIdSchema).max(15),
          })
          .strict(),
      )
      .length(ARCHITECTURE_PATTERN_IDS.length),
  })
  .strict();

type MutablePatternRegistryDocument = z.infer<typeof PatternRegistryDocumentSchema>;
type DeepReadonly<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

export type ArchitecturePatternRegistry = DeepReadonly<MutablePatternRegistryDocument>;
export type ArchitecturePattern = ArchitecturePatternRegistry["patterns"][number];
export type InvariantFamily = ArchitecturePatternRegistry["invariant_families"][number];
export type MinimumInvariant = ArchitecturePatternRegistry["invariants"][number];

export type PatternRegistryFailureReason =
  | "missing_resource"
  | "unreadable_resource"
  | "corrupt_json"
  | "unsupported_schema_version"
  | "duplicate_identifier"
  | "invalid_registry";

export class PatternRegistryInvalidError extends Error {
  override readonly name = "PatternRegistryInvalidError";
  readonly reason: PatternRegistryFailureReason;
  readonly source: string;

  constructor(reason: PatternRegistryFailureReason, source: string, detail: string) {
    super(`Architecture pattern registry ${reason.replaceAll("_", " ")} (${source}): ${detail}`);
    this.reason = reason;
    this.source = source;
  }
}

export interface LoadArchitecturePatternRegistryOptions {
  readonly resourcePath?: string;
}

export const DEFAULT_ARCHITECTURE_PATTERN_RESOURCE_PATH = fileURLToPath(
  new URL("../resources/architecture-patterns.json", import.meta.url),
);

const registryCache = new Map<string, ArchitecturePatternRegistry>();

function deepFreeze<Value>(value: Value): DeepReadonly<Value> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<Value>;
}

function duplicateId<Item>(items: readonly Item[], selectId: (item: Item) => string): string | undefined {
  const observed = new Set<string>();
  for (const item of items) {
    const id = selectId(item);
    if (observed.has(id)) return id;
    observed.add(id);
  }
  return undefined;
}

function assertUnique<Item>(
  items: readonly Item[],
  selectId: (item: Item) => string,
  label: string,
  source: string,
): void {
  const duplicate = duplicateId(items, selectId);
  if (duplicate !== undefined) {
    throw new PatternRegistryInvalidError(
      "duplicate_identifier",
      source,
      `${label} contains duplicate identifier ${duplicate}.`,
    );
  }
}

function assertExactIdentifiers(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
  source: string,
): void {
  const actualIds = new Set(actual);
  const missing = expected.filter((id) => !actualIds.has(id));
  const unexpected = actual.filter((id) => !expected.includes(id));
  if (missing.length > 0 || unexpected.length > 0) {
    const details = [
      missing.length > 0 ? `missing ${missing.join(", ")}` : "",
      unexpected.length > 0 ? `unexpected ${unexpected.join(", ")}` : "",
    ].filter((entry) => entry.length > 0);
    throw new PatternRegistryInvalidError(
      "invalid_registry",
      source,
      `${label} identifiers are not the reviewed invariant set: ${details.join("; ")}.`,
    );
  }
}

function formattedIssues(error: z.ZodError): string {
  const shown = error.issues.slice(0, 5).map((issue) => {
    const location = issue.path.length === 0 ? "<root>" : issue.path.join(".");
    return `${location}: ${issue.message}`;
  });
  if (error.issues.length > shown.length) shown.push(`${error.issues.length - shown.length} more issue(s)`);
  return shown.join("; ");
}

function hasSchemaVersion(input: unknown): input is { readonly schema_version: unknown } {
  return input !== null &&
    typeof input === "object" &&
    Object.prototype.hasOwnProperty.call(input, "schema_version");
}

/**
 * Validates both the document shape and every identifier/reference relationship.
 * Returned data is deeply frozen so callers cannot mutate validated registry state.
 */
export function validateArchitecturePatternRegistry(
  input: unknown,
  source = "<memory>",
): ArchitecturePatternRegistry {
  if (hasSchemaVersion(input) && input.schema_version !== 1) {
    throw new PatternRegistryInvalidError(
      "unsupported_schema_version",
      source,
      "Only architecture pattern registry schema_version 1 is supported.",
    );
  }

  const parsed = PatternRegistryDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new PatternRegistryInvalidError(
      "invalid_registry",
      source,
      formattedIssues(parsed.error),
    );
  }
  const registry = parsed.data;

  assertUnique(registry.patterns, (item) => item.id, "patterns", source);
  assertUnique(registry.invariant_families, (item) => item.id, "invariant_families", source);
  assertUnique(registry.invariants, (item) => item.id, "invariants", source);
  for (const family of registry.invariant_families) {
    assertUnique(family.required_pattern_ids, (id) => id, `${family.id}.required_pattern_ids`, source);
    assertUnique(
      family.incompatible_pattern_ids,
      (id) => id,
      `${family.id}.incompatible_pattern_ids`,
      source,
    );
    assertUnique(
      family.required_invariant_ids,
      (id) => id,
      `${family.id}.required_invariant_ids`,
      source,
    );
  }
  for (const pattern of registry.patterns) {
    assertUnique(
      pattern.minimum_invariant_ids,
      (id) => id,
      `${pattern.id}.minimum_invariant_ids`,
      source,
    );
  }

  assertExactIdentifiers(
    registry.patterns.map((item) => item.id),
    ARCHITECTURE_PATTERN_IDS,
    "patterns",
    source,
  );
  assertExactIdentifiers(
    registry.invariant_families.map((item) => item.id),
    INVARIANT_FAMILY_IDS,
    "invariant_families",
    source,
  );
  assertExactIdentifiers(
    registry.invariants.map((item) => item.id),
    MINIMUM_INVARIANT_IDS,
    "invariants",
    source,
  );

  const invariantsById = new Map(registry.invariants.map((item) => [item.id, item]));
  for (const family of registry.invariant_families) {
    const familyDefinitionIds = registry.invariants
      .filter((item) => item.family_id === family.id)
      .map((item) => item.id);
    assertExactIdentifiers(
      family.required_invariant_ids,
      familyDefinitionIds,
      `${family.id}.required_invariant_ids`,
      source,
    );
    for (const invariantId of family.required_invariant_ids) {
      if (invariantsById.get(invariantId)?.family_id !== family.id) {
        throw new PatternRegistryInvalidError(
          "invalid_registry",
          source,
          `${family.id} references invariant ${invariantId} from another family.`,
        );
      }
    }
  }

  return deepFreeze(registry);
}

function readAndValidateRegistry(resourcePath: string): ArchitecturePatternRegistry {
  let raw: string;
  try {
    raw = readFileSync(resourcePath, "utf8");
  } catch (error: unknown) {
    const code = error !== null && typeof error === "object" && "code" in error
      ? String(error.code)
      : undefined;
    throw new PatternRegistryInvalidError(
      code === "ENOENT" ? "missing_resource" : "unreadable_resource",
      resourcePath,
      code === "ENOENT" ? "The packaged resource file was not found." : "The packaged resource could not be read.",
    );
  }

  let input: unknown;
  try {
    input = JSON.parse(raw) as unknown;
  } catch {
    throw new PatternRegistryInvalidError(
      "corrupt_json",
      resourcePath,
      "The packaged resource is not valid JSON.",
    );
  }
  return validateArchitecturePatternRegistry(input, resourcePath);
}

/** Loads and immutably caches the registry relative to this installed module. */
export function loadArchitecturePatternRegistry(
  options: LoadArchitecturePatternRegistryOptions = {},
): ArchitecturePatternRegistry {
  const resourcePath = path.resolve(options.resourcePath ?? DEFAULT_ARCHITECTURE_PATTERN_RESOURCE_PATH);
  const cached = registryCache.get(resourcePath);
  if (cached !== undefined) return cached;

  const registry = readAndValidateRegistry(resourcePath);
  registryCache.set(resourcePath, registry);
  return registry;
}

export function getArchitecturePattern(
  registry: ArchitecturePatternRegistry,
  id: ArchitecturePatternId,
): ArchitecturePattern {
  const pattern = registry.patterns.find((item) => item.id === id);
  if (pattern === undefined) throw new Error(`Validated architecture pattern is missing: ${id}`);
  return pattern;
}

export function getInvariantFamily(
  registry: ArchitecturePatternRegistry,
  id: InvariantFamilyId,
): InvariantFamily {
  const family = registry.invariant_families.find((item) => item.id === id);
  if (family === undefined) throw new Error(`Validated invariant family is missing: ${id}`);
  return family;
}

export function getMinimumInvariant(
  registry: ArchitecturePatternRegistry,
  id: MinimumInvariantId,
): MinimumInvariant {
  const invariant = registry.invariants.find((item) => item.id === id);
  if (invariant === undefined) throw new Error(`Validated minimum invariant is missing: ${id}`);
  return invariant;
}
