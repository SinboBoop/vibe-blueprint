import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  ActivityActionSchema as ProductionActivityActionSchema,
  ActivityRuleIdSchema,
} from "./activity-risk.js";
import { ModelCheckReasonSchema } from "./doctor.js";
import { MINIMUM_INVARIANT_IDS } from "./invariant-ids.js";
import {
  AbstentionReasonSchema as ProductionAbstentionReasonSchema,
  ArchitecturePatternSchema,
  InteractionModeSchema,
} from "./schemas.js";

export const REGRESSION_INVENTORY_SCHEMA_VERSION = 1;
export const REGRESSION_INVENTORY_RELEASE_FLOOR = 30;

export const REGRESSION_CATEGORIES = [
  "doctor_missing_credential",
  "doctor_missing_probe",
  "ordinary_expense_workflow",
  "financial_records_without_funds_control",
  "invoice_payment_negation",
  "actual_money_movement",
  "credit_decision",
  "investment_advice",
  "critical_security",
  "critical_privacy",
  "offline_continuity",
  "multi_organization_isolation",
  "static_demo_production_records",
  "real_payments",
  "sensitive_data",
  "false_choices",
  "eliminated_recommendation",
  "three_or_more_routes",
  "candidate_permutations",
  "material_fact_flips",
  "bilingual_mixed_language",
  "prompt_injection",
  "requested_model_diagnostics",
  "critical_risk_actions",
  "financial_scope_ambiguity",
  "routine_privacy",
  "offline_optional",
  "single_organization",
  "disposable_static_demo",
  "record_only_expense",
  "sensitive_data_lifecycle",
] as const;

export const REQUIRED_REGRESSION_CATEGORIES = Object.freeze([
  ...REGRESSION_CATEGORIES,
]);

export const REGRESSION_TRANSFORMATIONS = [
  "paraphrase",
  "translation",
  "negation",
  "permutation",
  "material_flip",
  "prompt_injection",
] as const;

const StableIdSchema = z.string().min(3).max(96).regex(/^[a-z0-9][a-z0-9_-]*$/u);
const LanguageSchema = z.enum(["en", "zh", "mixed"]);
const CategorySchema = z.enum(REGRESSION_CATEGORIES);
export const RegressionTransformationSchema = z.enum(REGRESSION_TRANSFORMATIONS);

const InteractionModeExpectationSchema = z.enum([
  "not_applicable",
  ...InteractionModeSchema.options,
]);
const ActivitySubtypeSchema = ActivityRuleIdSchema.nullable();
const MinimumInvariantIdSchema = z.enum(MINIMUM_INVARIANT_IDS);

const DoctorExpectationSchema = z.object({
  status: z.enum(["pass", "fail", "skipped"]),
  reason: ModelCheckReasonSchema,
  overall_ok: z.boolean(),
}).strict();

export const RegressionExpectedResultSchema = z.object({
  interaction_modes: z.array(InteractionModeExpectationSchema).min(1).max(6),
  activity_subtypes: z.array(ActivitySubtypeSchema).min(1).optional(),
  activity_actions: z.array(ProductionActivityActionSchema).min(1).optional(),
  permitted_route_ids: z.array(StableIdSchema).min(1).optional(),
  prohibited_route_ids: z.array(StableIdSchema).min(1).optional(),
  permitted_pattern_ids: z.array(ArchitecturePatternSchema).min(1).optional(),
  prohibited_pattern_ids: z.array(ArchitecturePatternSchema).min(1).optional(),
  question_key: StableIdSchema.nullable().optional(),
  abstention_reason: ProductionAbstentionReasonSchema.nullable().optional(),
  doctor: DoctorExpectationSchema.optional(),
  required_elimination_reasons: z.array(StableIdSchema).min(1).optional(),
  required_invariant_ids: z.array(MinimumInvariantIdSchema).min(1).optional(),
  required_trace_ids: z.array(StableIdSchema).min(1).optional(),
}).strict().superRefine((expected, context) => {
  const modes = new Set(expected.interaction_modes);
  if (modes.size !== expected.interaction_modes.length) {
    context.addIssue({ code: "custom", path: ["interaction_modes"], message: "must not contain duplicates" });
  }
  if (modes.has("confirm_fact") && expected.question_key === undefined) {
    context.addIssue({ code: "custom", path: ["question_key"], message: "is required for confirm_fact" });
  }
  if (modes.has("abstain") && (expected.abstention_reason === undefined || expected.abstention_reason === null)) {
    context.addIssue({ code: "custom", path: ["abstention_reason"], message: "is required for abstain" });
  }
});

const DoctorInputSchema = z.object({
  kind: z.literal("doctor"),
  check_model: z.boolean(),
  credential_status: z.enum(["configured", "missing"]),
  probe_outcome: z.enum([
    "not_supplied",
    "success",
    "timeout",
    "endpoint_failure",
    "configured_model_rejected",
    "invalid_structured_output",
  ]),
}).strict();

const InventoryFactSchema = z.object({
  key: StableIdSchema,
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  certainty: z.enum(["explicit", "inferred", "defaulted", "unknown_critical"]),
}).strict();

const InventoryRiskSchema = z.object({
  domain: z.enum([
    "medical",
    "financial",
    "children_data",
    "complex_compliance",
    "capability_boundary",
    "security",
    "privacy",
    "payments",
    "general",
  ]),
  severity: z.enum(["low", "moderate", "high", "critical"]),
  requires_escalation: z.boolean(),
}).strict();

const ActivityInputSchema = z.object({
  kind: z.literal("activity"),
  facts: z.array(InventoryFactSchema).max(30),
  risk_assessments: z.array(InventoryRiskSchema).max(20),
  repository_context: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("summary"),
      content: z.string().min(1).max(20_000),
    }).strict(),
    z.object({
      kind: z.literal("diff"),
      content: z.string().min(1).max(100_000),
    }).strict(),
  ]).optional(),
}).strict();

const RouteFixtureSchema = z.object({
  id: StableIdSchema,
  pattern: ArchitecturePatternSchema,
  consequence_group: StableIdSchema,
  satisfies_hard_constraints: z.boolean(),
  dominated: z.boolean(),
  business_owned: z.boolean(),
  durable_tradeoff: z.boolean(),
}).strict();

const RouteResolutionInputSchema = z.object({
  kind: z.literal("route_resolution"),
  routes: z.array(RouteFixtureSchema).min(1).max(5),
  recommended_route_id: StableIdSchema,
  critical_question_key: StableIdSchema.nullable(),
}).strict().superRefine((input, context) => {
  const routeIds = new Set<string>();
  for (const [index, route] of input.routes.entries()) {
    if (routeIds.has(route.id)) {
      context.addIssue({ code: "custom", path: ["routes", index, "id"], message: `duplicate route id: ${route.id}` });
    }
    routeIds.add(route.id);
  }
  if (!routeIds.has(input.recommended_route_id)) {
    context.addIssue({ code: "custom", path: ["recommended_route_id"], message: "must name a declared route" });
  }
});

const ProtectedCapabilitySchema = z.enum([
  "authoritative_production_records",
  "multi_user_workflow_state",
  "offline_continuity",
  "multi_organization",
  "real_payments",
  "sensitive_data",
]);

const PatternInvariantInputSchema = z.object({
  kind: z.literal("pattern_invariant"),
  pattern: ArchitecturePatternSchema,
  required_capabilities: z.array(ProtectedCapabilitySchema).max(6),
  satisfied_invariant_ids: z.array(MinimumInvariantIdSchema).max(MINIMUM_INVARIANT_IDS.length),
}).strict();

export const RegressionDeterministicInputSchema = z.discriminatedUnion("kind", [
  DoctorInputSchema,
  ActivityInputSchema,
  RouteResolutionInputSchema,
  PatternInvariantInputSchema,
]);

const MaterialChangeFieldSchema = z.enum([
  "interaction_modes",
  "activity_subtypes",
  "activity_actions",
  "permitted_route_ids",
  "prohibited_route_ids",
  "question_key",
  "abstention_reason",
  "doctor_status",
]);

const MaterialChangeSchema = z.object({
  field: MaterialChangeFieldSchema,
  from: z.string(),
  to: z.string(),
}).strict().refine((change) => change.from !== change.to, {
  message: "from and to must differ",
  path: ["to"],
});

const JsonPointerSchema = z.string().min(1).max(512).regex(
  /^(?:\/(?:[^~/]|~[01])*)+$/u,
  "must be an RFC 6901 JSON Pointer relative to input",
);

const MaterialInputAssertionSchema = z.object({
  id: StableIdSchema,
  source_path: JsonPointerSchema,
  derived_path: JsonPointerSchema.optional(),
  relationship: z.enum(["preserved", "flipped"]),
  comparison: z.enum(["exact", "unordered_array"]).default("exact"),
}).strict();

const CaseBaseSchema = z.object({
  id: StableIdSchema,
  language: LanguageSchema,
  requirement: z.string().min(1).max(20_000),
  input: RegressionDeterministicInputSchema,
  expected: RegressionExpectedResultSchema,
});

const OriginalCaseSchema = CaseBaseSchema.extend({
  provenance: z.literal("original"),
  source_family_id: z.never().optional(),
  transformation: z.never().optional(),
  material_changes: z.never().optional(),
  material_input_assertions: z.never().optional(),
}).strict();

const DerivedCaseSchema = CaseBaseSchema.extend({
  provenance: z.literal("derived"),
  source_family_id: StableIdSchema,
  transformation: RegressionTransformationSchema,
  material_changes: z.array(MaterialChangeSchema).min(1).optional(),
  material_input_assertions: z.array(MaterialInputAssertionSchema).min(1).max(30),
}).strict().superRefine((regressionCase, context) => {
  if (regressionCase.transformation === "material_flip" && regressionCase.material_changes === undefined) {
    context.addIssue({ code: "custom", path: ["material_changes"], message: "is required for material_flip" });
  }
  if (regressionCase.transformation !== "material_flip" && regressionCase.material_changes !== undefined) {
    context.addIssue({ code: "custom", path: ["material_changes"], message: "is only valid for material_flip" });
  }
  const assertionIds = regressionCase.material_input_assertions.map((assertion) => assertion.id);
  if (new Set(assertionIds).size !== assertionIds.length) {
    context.addIssue({ code: "custom", path: ["material_input_assertions"], message: "must not contain duplicate IDs" });
  }
  const flipped = regressionCase.material_input_assertions.some((assertion) => assertion.relationship === "flipped");
  if (regressionCase.transformation === "material_flip" && !flipped) {
    context.addIssue({ code: "custom", path: ["material_input_assertions"], message: "material_flip requires at least one flipped input assertion" });
  }
  if (regressionCase.transformation !== "material_flip" && flipped) {
    context.addIssue({ code: "custom", path: ["material_input_assertions"], message: "only material_flip may declare a flipped input assertion" });
  }
});

export const RegressionCaseSchema = z.discriminatedUnion("provenance", [
  OriginalCaseSchema,
  DerivedCaseSchema,
]);

export const RegressionFamilySchema = z.object({
  id: StableIdSchema,
  title: z.string().min(1).max(200),
  review_status: z.literal("maintainer_reviewed"),
  language: LanguageSchema,
  categories: z.array(CategorySchema).min(1).max(REGRESSION_CATEGORIES.length),
  rationale: z.string().min(1).max(1_000),
  cases: z.array(RegressionCaseSchema).min(1).max(30),
}).strict();

export const RegressionInventoryDocumentSchema = z.object({
  schema_version: z.literal(REGRESSION_INVENTORY_SCHEMA_VERSION),
  families: z.array(RegressionFamilySchema).min(1),
}).strict();

export type RegressionTransformation = z.infer<typeof RegressionTransformationSchema>;
export type RegressionExpectedResult = z.infer<typeof RegressionExpectedResultSchema>;
export type RegressionDeterministicInput = z.infer<typeof RegressionDeterministicInputSchema>;
export type RegressionCase = z.infer<typeof RegressionCaseSchema>;
export type RegressionFamily = z.infer<typeof RegressionFamilySchema>;
export type RegressionInventoryDocument = z.infer<typeof RegressionInventoryDocumentSchema>;

export interface LoadedRegressionInventory {
  readonly schemaVersion: 1;
  readonly files: readonly string[];
  readonly families: readonly RegressionFamily[];
  readonly cases: readonly RegressionCase[];
}

export interface InventoryDiagnostic {
  readonly file: string;
  readonly family: string | null;
  readonly case: string | null;
  readonly field: string;
  readonly reason: string;
}

export class InventoryCaseInvalidError extends Error {
  override readonly name = "InventoryCaseInvalidError";
  readonly diagnostic: InventoryDiagnostic;

  constructor(diagnostic: InventoryDiagnostic) {
    super(formatInventoryDiagnostic(diagnostic));
    this.diagnostic = diagnostic;
  }
}

function formatInventoryDiagnostic(diagnostic: InventoryDiagnostic): string {
  return `Invalid regression inventory: file=${diagnostic.file}; family=${diagnostic.family ?? "<unknown>"}; case=${diagnostic.case ?? "<unknown>"}; field=${diagnostic.field}; ${diagnostic.reason}`;
}

function rawRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function rawIdentifier(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function diagnosticLocation(
  file: string,
  raw: unknown,
  issuePath: readonly PropertyKey[],
): Omit<InventoryDiagnostic, "reason"> {
  const document = rawRecord(raw);
  const families = Array.isArray(document?.families) ? document.families : [];
  const familyIndex = issuePath[0] === "families" && typeof issuePath[1] === "number"
    ? issuePath[1]
    : undefined;
  const familyRaw = familyIndex === undefined ? undefined : rawRecord(families[familyIndex]);
  const cases = Array.isArray(familyRaw?.cases) ? familyRaw.cases : [];
  const casePathIndex = issuePath.findIndex((part) => part === "cases");
  const caseIndex = casePathIndex >= 0 && typeof issuePath[casePathIndex + 1] === "number"
    ? issuePath[casePathIndex + 1] as number
    : undefined;
  const caseRaw = caseIndex === undefined ? undefined : rawRecord(cases[caseIndex]);
  return {
    file,
    family: rawIdentifier(familyRaw?.id),
    case: rawIdentifier(caseRaw?.id),
    field: issuePath.length === 0 ? "$" : issuePath.map(String).join("."),
  };
}

function throwDiagnostic(
  file: string,
  family: string | null,
  regressionCase: string | null,
  field: string,
  reason: string,
): never {
  throw new InventoryCaseInvalidError({ file, family, case: regressionCase, field, reason });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function expectedFieldValue(expected: RegressionExpectedResult, field: z.infer<typeof MaterialChangeFieldSchema>): string {
  if (field === "doctor_status") return expected.doctor?.status ?? "<unset>";
  const value = expected[field];
  return value === undefined ? "<unset>" : stableJson(value);
}

function materialExpectedSignature(expected: RegressionExpectedResult): string {
  return stableJson(Object.fromEntries(
    Object.entries(expected).filter(([key]) => key !== "required_trace_ids"),
  ));
}

function jsonPointerValue(input: unknown, pointer: string): { readonly found: boolean; readonly value?: unknown } {
  let current = input;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) return { found: false };
      const index = Number(token);
      if (index >= current.length) return { found: false };
      current = current[index];
    } else if (current !== null && typeof current === "object" && Object.hasOwn(current, token)) {
      current = (current as Record<string, unknown>)[token];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

function materialInputValue(value: unknown, comparison: "exact" | "unordered_array"): string {
  if (comparison === "unordered_array" && Array.isArray(value)) {
    return stableJson(value.map((entry: unknown) => stableJson(entry)).sort());
  }
  return stableJson(value);
}

function validateMaterialInputAssertions(
  file: string,
  family: RegressionFamily,
  regressionCase: Extract<RegressionCase, { provenance: "derived" }>,
  source: RegressionCase,
): void {
  const requiredPaths = (() => {
    switch (source.input.kind) {
      case "doctor":
        return ["/check_model", "/credential_status", "/probe_outcome"];
      case "activity":
        return ["/facts", "/risk_assessments"];
      case "route_resolution":
        return ["/routes", "/recommended_route_id", "/critical_question_key"];
      case "pattern_invariant":
        return ["/pattern", "/required_capabilities", "/satisfied_invariant_ids"];
    }
  })();
  const declaredPaths = new Set(regressionCase.material_input_assertions.map(
    (assertion) => assertion.source_path,
  ));
  for (const requiredPath of requiredPaths) {
    if (!declaredPaths.has(requiredPath)) {
      throwDiagnostic(
        file,
        family.id,
        regressionCase.id,
        "material_input_assertions",
        `must declare the material source input path ${requiredPath}`,
      );
    }
  }
  for (const [index, assertion] of regressionCase.material_input_assertions.entries()) {
    const derivedPath = assertion.derived_path ?? assertion.source_path;
    const sourceValue = jsonPointerValue(source.input, assertion.source_path);
    if (!sourceValue.found) {
      throwDiagnostic(
        file,
        family.id,
        regressionCase.id,
        `material_input_assertions.${index}.source_path`,
        `does not resolve in source input: ${assertion.source_path}`,
      );
    }
    const derivedValue = jsonPointerValue(regressionCase.input, derivedPath);
    if (!derivedValue.found) {
      throwDiagnostic(
        file,
        family.id,
        regressionCase.id,
        `material_input_assertions.${index}.derived_path`,
        `does not resolve in derived input: ${derivedPath}`,
      );
    }
    const sourceSignature = materialInputValue(sourceValue.value, assertion.comparison);
    const derivedSignature = materialInputValue(derivedValue.value, assertion.comparison);
    if (assertion.relationship === "preserved" && sourceSignature !== derivedSignature) {
      throwDiagnostic(
        file,
        family.id,
        regressionCase.id,
        `material_input_assertions.${index}`,
        `declared preserved input changed from ${sourceSignature} to ${derivedSignature}`,
      );
    }
    if (assertion.relationship === "flipped" && sourceSignature === derivedSignature) {
      throwDiagnostic(
        file,
        family.id,
        regressionCase.id,
        `material_input_assertions.${index}`,
        `declared flipped input did not change from ${sourceSignature}`,
      );
    }
  }
}

function validateExpectedRelevance(file: string, family: RegressionFamily, regressionCase: RegressionCase): void {
  const expected = regressionCase.expected;
  const modeSet = new Set(expected.interaction_modes);
  if (regressionCase.input.kind === "doctor") {
    if (expected.doctor === undefined) {
      throwDiagnostic(file, family.id, regressionCase.id, "expected.doctor", "is required for a doctor case");
    }
    if (expected.interaction_modes.length !== 1 || !modeSet.has("not_applicable")) {
      throwDiagnostic(file, family.id, regressionCase.id, "expected.interaction_modes", "doctor cases must use only not_applicable");
    }
  } else {
    if (modeSet.has("not_applicable")) {
      throwDiagnostic(file, family.id, regressionCase.id, "expected.interaction_modes", "not_applicable is only valid for doctor cases");
    }
    if (expected.doctor !== undefined) {
      throwDiagnostic(file, family.id, regressionCase.id, "expected.doctor", "is only valid for doctor cases");
    }
  }
  if (regressionCase.input.kind === "activity" && expected.activity_actions === undefined) {
    throwDiagnostic(file, family.id, regressionCase.id, "expected.activity_actions", "activity cases require an action expectation");
  }
  if (regressionCase.input.kind === "route_resolution") {
    const hasRouteOracle = expected.permitted_route_ids !== undefined ||
      expected.prohibited_route_ids !== undefined || modeSet.has("confirm_fact") || modeSet.has("abstain");
    if (!hasRouteOracle) {
      throwDiagnostic(file, family.id, regressionCase.id, "expected.permitted_route_ids", "route cases require a route, question, or abstention oracle");
    }
  }
  if (regressionCase.input.kind === "pattern_invariant") {
    const hasInvariantOracle = expected.permitted_pattern_ids !== undefined ||
      expected.prohibited_pattern_ids !== undefined || expected.required_invariant_ids !== undefined;
    if (!hasInvariantOracle) {
      throwDiagnostic(file, family.id, regressionCase.id, "expected.required_invariant_ids", "pattern cases require a pattern or invariant oracle");
    }
  }
}

function validateDocumentSemantics(
  file: string,
  document: RegressionInventoryDocument,
  familyLocations: Map<string, string>,
  caseLocations: Map<string, { readonly file: string; readonly family: string }>,
): void {
  for (const family of document.families) {
    const priorFamilyFile = familyLocations.get(family.id);
    if (priorFamilyFile !== undefined) {
      throwDiagnostic(file, family.id, null, "id", `duplicate family id; first declared in ${priorFamilyFile}`);
    }
    familyLocations.set(family.id, file);
    if (new Set(family.categories).size !== family.categories.length) {
      throwDiagnostic(file, family.id, null, "categories", "must not contain duplicates");
    }
    const originals = family.cases.filter((regressionCase) => regressionCase.provenance === "original");
    if (originals.length !== 1) {
      throwDiagnostic(file, family.id, null, "cases", "must contain exactly one original maintainer-reviewed case");
    }
    if (originals[0]?.language !== family.language) {
      throwDiagnostic(file, family.id, originals[0]?.id ?? null, "language", "original case language must equal family language");
    }
    for (const regressionCase of family.cases) {
      const priorCase = caseLocations.get(regressionCase.id);
      if (priorCase !== undefined) {
        throwDiagnostic(file, family.id, regressionCase.id, "id", `duplicate case id; first declared in ${priorCase.file} family ${priorCase.family}`);
      }
      caseLocations.set(regressionCase.id, { file, family: family.id });
      validateExpectedRelevance(file, family, regressionCase);
    }
  }
}

function validateDerivedReferences(
  inventory: LoadedRegressionInventory,
  familyLocations: ReadonlyMap<string, string>,
): void {
  const families = new Map(inventory.families.map((family) => [family.id, family]));
  for (const family of inventory.families) {
    const file = familyLocations.get(family.id) ?? "<unknown>";
    for (const regressionCase of family.cases) {
      if (regressionCase.provenance !== "derived") continue;
      const sourceFamily = families.get(regressionCase.source_family_id);
      if (sourceFamily === undefined) {
        throwDiagnostic(file, family.id, regressionCase.id, "source_family_id", `unknown family reference: ${regressionCase.source_family_id}`);
      }
      const source = sourceFamily.cases.find((candidate) => candidate.provenance === "original");
      if (source === undefined) {
        throwDiagnostic(file, family.id, regressionCase.id, "source_family_id", "referenced family has no original case");
      }
      if (source.input.kind !== regressionCase.input.kind) {
        throwDiagnostic(file, family.id, regressionCase.id, "input.kind", `must preserve source input kind ${source.input.kind}`);
      }
      validateMaterialInputAssertions(file, family, regressionCase, source);
      if (regressionCase.transformation === "material_flip") {
        for (const [index, change] of (regressionCase.material_changes ?? []).entries()) {
          const actualFrom = expectedFieldValue(source.expected, change.field);
          const actualTo = expectedFieldValue(regressionCase.expected, change.field);
          if (change.from !== actualFrom) {
            throwDiagnostic(file, family.id, regressionCase.id, `material_changes.${index}.from`, `must equal source expectation ${actualFrom}`);
          }
          if (change.to !== actualTo) {
            throwDiagnostic(file, family.id, regressionCase.id, `material_changes.${index}.to`, `must equal derived expectation ${actualTo}`);
          }
        }
        if (materialExpectedSignature(source.expected) === materialExpectedSignature(regressionCase.expected)) {
          throwDiagnostic(file, family.id, regressionCase.id, "expected", "material_flip must change at least one expected result");
        }
      } else if (materialExpectedSignature(source.expected) !== materialExpectedSignature(regressionCase.expected)) {
        throwDiagnostic(file, family.id, regressionCase.id, "expected", `${regressionCase.transformation} must preserve the source material expectation; use material_flip when it changes`);
      }
    }
  }
}

async function parseInventoryFile(file: string): Promise<{ readonly file: string; readonly document: RegressionInventoryDocument }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    const reason = error instanceof SyntaxError ? `invalid JSON: ${error.message}` : `cannot read file: ${error instanceof Error ? error.message : String(error)}`;
    throwDiagnostic(file, null, null, "$", reason);
  }
  const parsed = RegressionInventoryDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue === undefined) throwDiagnostic(file, null, null, "$", "schema validation failed");
    const location = diagnosticLocation(file, raw, issue.path);
    throw new InventoryCaseInvalidError({ ...location, reason: issue.message });
  }
  return { file, document: parsed.data };
}

export async function loadRegressionInventoryFiles(files: readonly string[]): Promise<LoadedRegressionInventory> {
  if (files.length === 0) {
    throwDiagnostic("<none>", null, null, "$", "at least one inventory file is required");
  }
  const normalizedFiles = [...new Set(files.map((file) => path.resolve(file)))].sort();
  const parsed = [];
  for (const file of normalizedFiles) parsed.push(await parseInventoryFile(file));
  const familyLocations = new Map<string, string>();
  const caseLocations = new Map<string, { readonly file: string; readonly family: string }>();
  for (const item of parsed) {
    validateDocumentSemantics(item.file, item.document, familyLocations, caseLocations);
  }
  const families = parsed.flatMap((item) => item.document.families);
  const inventory: LoadedRegressionInventory = {
    schemaVersion: REGRESSION_INVENTORY_SCHEMA_VERSION,
    files: normalizedFiles,
    families,
    cases: families.flatMap((family) => family.cases),
  };
  validateDerivedReferences(inventory, familyLocations);
  return inventory;
}

export const DEFAULT_REGRESSION_INVENTORY_DIRECTORY = fileURLToPath(
  new URL("../resources/regression-inventory", import.meta.url),
);

export async function loadRegressionInventoryDirectory(
  directory = DEFAULT_REGRESSION_INVENTORY_DIRECTORY,
): Promise<LoadedRegressionInventory> {
  let files: string[];
  try {
    files = (await readdir(directory))
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => path.join(directory, entry))
      .sort();
  } catch (error) {
    throwDiagnostic(directory, null, null, "$", `cannot read inventory directory: ${error instanceof Error ? error.message : String(error)}`);
  }
  return loadRegressionInventoryFiles(files);
}

export interface RegressionInventoryCoverageReport {
  readonly schema_version: 1;
  readonly reviewed_family_count: number;
  readonly derived_variant_count: number;
  readonly total_case_count: number;
  readonly release_floor: number;
  readonly release_floor_met: boolean;
  readonly category_coverage: Readonly<Record<(typeof REGRESSION_CATEGORIES)[number], number>>;
  readonly missing_required_categories: readonly (typeof REGRESSION_CATEGORIES)[number][];
  readonly original_language_coverage: Readonly<Record<"en" | "zh" | "mixed", number>>;
  readonly derived_language_coverage: Readonly<Record<"en" | "zh" | "mixed", number>>;
  readonly transformation_coverage: Readonly<Record<RegressionTransformation, number>>;
  readonly claim_scope: "maintainer_reviewed_known_regressions";
  readonly statement: string;
}

function countValues<const Values extends readonly string[]>(values: Values): Record<Values[number], number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<Values[number], number>;
}

export function createRegressionInventoryCoverageReport(
  inventory: LoadedRegressionInventory,
): RegressionInventoryCoverageReport {
  const categoryCoverage = countValues(REGRESSION_CATEGORIES);
  const originalLanguageCoverage = countValues(["en", "zh", "mixed"] as const);
  const derivedLanguageCoverage = countValues(["en", "zh", "mixed"] as const);
  const transformationCoverage = countValues(REGRESSION_TRANSFORMATIONS);
  let derivedVariantCount = 0;
  for (const family of inventory.families) {
    originalLanguageCoverage[family.language] += 1;
    for (const category of family.categories) categoryCoverage[category] += 1;
    for (const regressionCase of family.cases) {
      if (regressionCase.provenance !== "derived") continue;
      derivedVariantCount += 1;
      derivedLanguageCoverage[regressionCase.language] += 1;
      transformationCoverage[regressionCase.transformation] += 1;
    }
  }
  const missingRequiredCategories = REQUIRED_REGRESSION_CATEGORIES.filter(
    (category) => categoryCoverage[category] === 0,
  );
  return {
    schema_version: REGRESSION_INVENTORY_SCHEMA_VERSION,
    reviewed_family_count: inventory.families.length,
    derived_variant_count: derivedVariantCount,
    total_case_count: inventory.cases.length,
    release_floor: REGRESSION_INVENTORY_RELEASE_FLOOR,
    release_floor_met: inventory.families.length >= REGRESSION_INVENTORY_RELEASE_FLOOR,
    category_coverage: categoryCoverage,
    missing_required_categories: missingRequiredCategories,
    original_language_coverage: originalLanguageCoverage,
    derived_language_coverage: derivedLanguageCoverage,
    transformation_coverage: transformationCoverage,
    claim_scope: "maintainer_reviewed_known_regressions",
    statement: "This inventory checks only the maintainer-reviewed integrity regressions and boundaries represented by its cases; it is not a representative benchmark or a claim of universal decision correctness.",
  };
}

export class RegressionInventoryCoverageError extends Error {
  override readonly name = "RegressionInventoryCoverageError";
}

export function assertRegressionInventoryReleaseCoverage(
  report: RegressionInventoryCoverageReport,
): void {
  const failures: string[] = [];
  if (!report.release_floor_met) {
    failures.push(`reviewed family count ${report.reviewed_family_count} is below release floor ${report.release_floor}`);
  }
  if (report.missing_required_categories.length > 0) {
    failures.push(`missing required categories: ${report.missing_required_categories.join(", ")}`);
  }
  if (failures.length > 0) throw new RegressionInventoryCoverageError(failures.join("; "));
}

export const RegressionObservationSchema = z.object({
  interaction_mode: InteractionModeExpectationSchema,
  activity_subtype: ActivitySubtypeSchema,
  activity_action: ProductionActivityActionSchema.nullable(),
  selected_route_id: StableIdSchema.nullable(),
  offered_route_ids: z.array(StableIdSchema),
  pattern_id: ArchitecturePatternSchema.nullable(),
  question_key: StableIdSchema.nullable(),
  abstention_reason: ProductionAbstentionReasonSchema.nullable(),
  doctor: DoctorExpectationSchema.nullable(),
  elimination_reasons: z.array(StableIdSchema),
  invariant_ids: z.array(MinimumInvariantIdSchema),
  trace_ids: z.array(StableIdSchema),
}).strict();

export type RegressionObservation = z.infer<typeof RegressionObservationSchema>;

export interface RegressionExecutor {
  execute(
    regressionCase: RegressionCase,
    family: RegressionFamily,
  ): unknown;
}

export interface RegressionCaseRunResult {
  readonly family_id: string;
  readonly case_id: string;
  readonly passed: boolean;
  readonly mismatches: readonly string[];
}

export interface RegressionInventoryRunReport {
  readonly coverage: RegressionInventoryCoverageReport;
  readonly executed_case_count: number;
  readonly passed_case_count: number;
  readonly failed_case_count: number;
  readonly results: readonly RegressionCaseRunResult[];
  readonly statement: string;
}

function includesAll(actual: readonly string[], required: readonly string[]): boolean {
  const actualSet = new Set(actual);
  return required.every((entry) => actualSet.has(entry));
}

function compareObservation(
  expected: RegressionExpectedResult,
  observed: RegressionObservation,
): readonly string[] {
  const mismatches: string[] = [];
  if (!expected.interaction_modes.includes(observed.interaction_mode)) {
    mismatches.push(`interaction_mode=${observed.interaction_mode} not in ${expected.interaction_modes.join("|")}`);
  }
  if (expected.activity_subtypes !== undefined && (
    !expected.activity_subtypes.includes(observed.activity_subtype)
  )) {
    mismatches.push(`activity_subtype=${observed.activity_subtype ?? "null"} not permitted`);
  }
  if (expected.activity_actions !== undefined && (
    observed.activity_action === null || !expected.activity_actions.includes(observed.activity_action)
  )) {
    mismatches.push(`activity_action=${observed.activity_action ?? "null"} not permitted`);
  }
  const observedRoutes = [
    ...(observed.selected_route_id === null ? [] : [observed.selected_route_id]),
    ...observed.offered_route_ids,
  ];
  if (expected.permitted_route_ids !== undefined && (
    observedRoutes.length === 0 || observedRoutes.some((routeId) => !expected.permitted_route_ids?.includes(routeId))
  )) {
    mismatches.push("observed route set is outside permitted_route_ids");
  }
  if (expected.prohibited_route_ids !== undefined && observedRoutes.some((routeId) => expected.prohibited_route_ids?.includes(routeId))) {
    mismatches.push("observed route set contains a prohibited_route_id");
  }
  if (expected.permitted_pattern_ids !== undefined && (
    observed.pattern_id === null || !expected.permitted_pattern_ids.includes(observed.pattern_id)
  )) {
    mismatches.push(`pattern_id=${observed.pattern_id ?? "null"} not permitted`);
  }
  if (expected.prohibited_pattern_ids !== undefined && observed.pattern_id !== null && expected.prohibited_pattern_ids.includes(observed.pattern_id)) {
    mismatches.push(`pattern_id=${observed.pattern_id} is prohibited`);
  }
  if (expected.question_key !== undefined && observed.question_key !== expected.question_key) {
    mismatches.push(`question_key=${observed.question_key ?? "null"} expected ${expected.question_key ?? "null"}`);
  }
  if (expected.abstention_reason !== undefined && observed.abstention_reason !== expected.abstention_reason) {
    mismatches.push(`abstention_reason=${observed.abstention_reason ?? "null"} expected ${expected.abstention_reason ?? "null"}`);
  }
  if (expected.doctor !== undefined && stableJson(observed.doctor) !== stableJson(expected.doctor)) {
    mismatches.push("doctor outcome does not match expected status/reason/overall_ok");
  }
  if (expected.required_elimination_reasons !== undefined && !includesAll(observed.elimination_reasons, expected.required_elimination_reasons)) {
    mismatches.push("required elimination reason is missing");
  }
  if (expected.required_invariant_ids !== undefined && !includesAll(observed.invariant_ids, expected.required_invariant_ids)) {
    mismatches.push("required invariant id is missing");
  }
  if (expected.required_trace_ids !== undefined && !includesAll(observed.trace_ids, expected.required_trace_ids)) {
    mismatches.push("required trace id is missing");
  }
  return mismatches;
}

export async function runRegressionInventory(
  inventory: LoadedRegressionInventory,
  executor: RegressionExecutor,
): Promise<RegressionInventoryRunReport> {
  const results: RegressionCaseRunResult[] = [];
  for (const family of inventory.families) {
    for (const regressionCase of family.cases) {
      let mismatches: readonly string[];
      try {
        const rawObservation = await executor.execute(regressionCase, family);
        const parsed = RegressionObservationSchema.safeParse(rawObservation);
        mismatches = parsed.success
          ? compareObservation(regressionCase.expected, parsed.data)
          : [`executor returned invalid observation: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`];
      } catch (error) {
        mismatches = [`executor failed: ${error instanceof Error ? error.message : String(error)}`];
      }
      results.push({
        family_id: family.id,
        case_id: regressionCase.id,
        passed: mismatches.length === 0,
        mismatches,
      });
    }
  }
  const passed = results.filter((result) => result.passed).length;
  return {
    coverage: createRegressionInventoryCoverageReport(inventory),
    executed_case_count: results.length,
    passed_case_count: passed,
    failed_case_count: results.length - passed,
    results,
    statement: "Case results apply only to the checked-in, maintainer-reviewed regression inventory and do not measure general project-foundation quality.",
  };
}
