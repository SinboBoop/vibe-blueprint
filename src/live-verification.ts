import { createHash } from "node:crypto";

import { z } from "zod";

import { InMemoryAnalysisStore } from "./analysis-store.js";
import { FoundationAnalysisService } from "./analysis-service.js";
import { loadConfig } from "./config.js";
import {
  ModelConfigurationError,
  ModelOutputBudgetError,
  ModelOutputValidationError,
  ModelRequestError,
  ResponsesModelClient,
} from "./model-client.js";
import {
  loadRegressionInventoryDirectory,
  type RegressionCase,
} from "./regression-inventory.js";
import { atomicWriteJson } from "./security.js";
import {
  InteractionModeSchema,
  type CandidateRoute,
  type DecisionResult,
  type InteractionMode,
} from "./schemas.js";

const LIVE_SMOKE_CASE_ID = "live_smoke_strict_analysis";
const LIVE_SMOKE_REQUIREMENT =
  "Plan the technical foundation for a small team scheduling Web application.";
export const DEFAULT_LIVE_REQUEST_TIMEOUT_MS = 600_000;
const DEFAULT_LIVE_INVENTORY_CASE_IDS = Object.freeze([
  "ordinary_expense_not_specialist_original",
  "offline_continuity_complete_original",
  "money_transfer_initiation_original",
] as const);

const LiveVerificationErrorCategorySchema = z.enum([
  "explicit_enable_required",
  "configuration_error",
  "credential_unavailable",
  "authentication_failed",
  "timeout",
  "endpoint_unavailable",
  "model_rejected",
  "model_mismatch",
  "invalid_structured_output",
  "output_budget_exhausted",
  "network_error",
  "provider_error",
  "inventory_error",
  "inventory_expectation_failed",
  "analysis_failed",
  "summary_write_failed",
]);

const LiveInteractionModeSchema = z.object({
  case_id: z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9_-]*$/u),
  interaction_mode: InteractionModeSchema,
}).strict();

const LiveVerificationSummarySchema = z.object({
  timestamp: z.string().min(1).max(64),
  base_url_sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  responses_path_kind: z.enum(["responses", "v1_responses", "custom"]).nullable(),
  exact_model: z.string().min(1).max(300).nullable(),
  status: z.enum(["passed", "failed"]),
  case_ids: z.array(z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9_-]*$/u)).min(1).max(16),
  case_count: z.number().int().min(1).max(16),
  completed_case_count: z.number().int().min(0).max(16),
  interaction_modes: z.array(LiveInteractionModeSchema).max(16),
  error_category: LiveVerificationErrorCategorySchema.nullable(),
}).strict().superRefine((summary, context) => {
  if (summary.case_count !== summary.case_ids.length) {
    context.addIssue({
      code: "custom",
      path: ["case_count"],
      message: "must equal case_ids length",
    });
  }
  if (summary.completed_case_count !== summary.interaction_modes.length) {
    context.addIssue({
      code: "custom",
      path: ["completed_case_count"],
      message: "must equal interaction_modes length",
    });
  }
  if (summary.status === "passed" && (
    summary.error_category !== null ||
    summary.completed_case_count !== summary.case_count
  )) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "passed requires every case to complete and no error category",
    });
  }
  if (summary.status === "failed" && summary.error_category === null) {
    context.addIssue({
      code: "custom",
      path: ["error_category"],
      message: "failed requires an error category",
    });
  }
});

export type LiveVerificationErrorCategory = z.infer<typeof LiveVerificationErrorCategorySchema>;

export interface LiveVerificationCaseMode {
  readonly case_id: string;
  readonly interaction_mode: InteractionMode;
}

export interface LiveVerificationSummary {
  readonly timestamp: string;
  readonly base_url_sha256: string | null;
  readonly responses_path_kind: "responses" | "v1_responses" | "custom" | null;
  readonly exact_model: string | null;
  readonly status: "passed" | "failed";
  readonly case_ids: readonly string[];
  readonly case_count: number;
  readonly completed_case_count: number;
  readonly interaction_modes: readonly LiveVerificationCaseMode[];
  readonly error_category: LiveVerificationErrorCategory | null;
}

export interface LiveVerificationOptions {
  /** A live provider call is forbidden unless the caller explicitly opts in. */
  readonly enabled?: boolean;
  /** When set, the same sanitized summary returned to the caller is atomically written here. */
  readonly outputPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly cachePath?: string;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly inventoryDirectory?: string;
  readonly caseIds?: readonly string[];
}

interface SummaryContext {
  readonly timestamp: string;
  readonly baseUrlSha256: string | null;
  readonly responsesPathKind: LiveVerificationSummary["responses_path_kind"];
  readonly exactModel: string | null;
  readonly caseIds: readonly string[];
  readonly modes: readonly LiveVerificationCaseMode[];
}

function timestamp(now: (() => Date) | undefined): string {
  try {
    return (now?.() ?? new Date()).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function selectedCaseIds(options: LiveVerificationOptions): readonly string[] {
  const configured = options.caseIds ?? DEFAULT_LIVE_INVENTORY_CASE_IDS;
  return [LIVE_SMOKE_CASE_ID, ...configured];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function responsesPathKind(
  value: string,
): NonNullable<LiveVerificationSummary["responses_path_kind"]> {
  if (value === "/responses") return "responses";
  if (value === "/v1/responses") return "v1_responses";
  return "custom";
}

function summary(
  context: SummaryContext,
  status: LiveVerificationSummary["status"],
  errorCategory: LiveVerificationErrorCategory | null,
): LiveVerificationSummary {
  return LiveVerificationSummarySchema.parse({
    timestamp: context.timestamp,
    base_url_sha256: context.baseUrlSha256,
    responses_path_kind: context.responsesPathKind,
    exact_model: context.exactModel,
    status,
    case_ids: [...context.caseIds],
    case_count: context.caseIds.length,
    completed_case_count: context.modes.length,
    interaction_modes: context.modes.map((entry) => ({ ...entry })),
    error_category: errorCategory,
  });
}

function classifyError(
  error: unknown,
  fallback: "analysis_failed" | "configuration_error" | "inventory_error",
): LiveVerificationErrorCategory {
  const message = error instanceof Error ? error.message.toLocaleLowerCase("en-US") : "";
  if (error instanceof ModelConfigurationError) {
    return /(?:no foundation llm api key|credential)/u.test(message)
      ? "credential_unavailable"
      : "configuration_error";
  }
  if (error instanceof ModelOutputBudgetError) return "output_budget_exhausted";
  if (error instanceof ModelOutputValidationError) return "invalid_structured_output";
  if (error instanceof ModelRequestError) {
    if (error.status === 401 || error.status === 403) return "authentication_failed";
    if (/(?:timed out|timeout|time-out)/u.test(message)) return "timeout";
    if (/(?:actual model|exact configured model|model probe reported)/u.test(message)) {
      return "model_mismatch";
    }
    if (
      /(?:model (?:was )?(?:rejected|unavailable|not found|unsupported)|unknown model|invalid model)/u.test(message) ||
      ((error.status === 400 || error.status === 404 || error.status === 422) && /model/u.test(message))
    ) return "model_rejected";
    if (
      error.status === 404 ||
      error.status === 405 ||
      /(?:neither \/responses nor \/v1\/responses|endpoint.*(?:missing|unavailable))/u.test(message)
    ) return "endpoint_unavailable";
    if (/(?:structured|strict schema|invalid json|output text|non-object body)/u.test(message)) {
      return "invalid_structured_output";
    }
    if (/(?:network|fetch failed|econn|enotfound|socket|connection)/u.test(message)) {
      return "network_error";
    }
    return "provider_error";
  }
  if (/(?:timed out|timeout|time-out)/u.test(message)) return "timeout";
  return fallback;
}

function selectInventoryCases(
  cases: readonly RegressionCase[],
  caseIds: readonly string[],
): readonly RegressionCase[] | undefined {
  if (
    caseIds.length < 1 ||
    caseIds.length > 15 ||
    new Set(caseIds).size !== caseIds.length ||
    caseIds.some((id) => !/^[a-z0-9][a-z0-9_-]*$/u.test(id))
  ) return undefined;
  const byId = new Map(cases.map((entry) => [entry.id, entry]));
  const selected = caseIds.map((id) => byId.get(id));
  return selected.some((entry) => entry === undefined)
    ? undefined
    : selected as readonly RegressionCase[];
}

function selectedPatterns(
  result: DecisionResult,
): readonly CandidateRoute["architecture"]["pattern"][] {
  if (result.interaction_mode === "abstain") return [];
  if (result.interaction_mode === "offer_two_routes") {
    return result.routes.map((route) => route.architecture.pattern);
  }
  return [result.architecture.pattern];
}

function matchesReviewedExpectation(
  result: DecisionResult,
  regressionCase: RegressionCase,
): boolean {
  const expected = regressionCase.expected;
  const expectedModes = expected.interaction_modes.filter((mode) => mode !== "not_applicable");
  if (!expectedModes.includes(result.interaction_mode)) return false;
  if (
    expected.activity_subtypes !== undefined &&
    !expected.activity_subtypes.includes(result.activity_risk.primary_activity)
  ) return false;
  if (
    expected.activity_actions !== undefined &&
    !expected.activity_actions.includes(result.activity_risk.action)
  ) return false;
  if (expected.question_key !== undefined) {
    const observed = result.interaction_mode === "confirm_fact"
      ? result.question_key ?? null
      : null;
    if (observed !== expected.question_key) return false;
  }
  if (expected.abstention_reason !== undefined) {
    const observed = result.interaction_mode === "abstain"
      ? result.abstention_reason
      : null;
    if (observed !== expected.abstention_reason) return false;
  }
  const patterns = selectedPatterns(result);
  if (
    expected.permitted_pattern_ids !== undefined &&
    (patterns.length === 0 || patterns.some((pattern) => !expected.permitted_pattern_ids?.includes(pattern)))
  ) return false;
  if (
    expected.prohibited_pattern_ids !== undefined &&
    patterns.some((pattern) => expected.prohibited_pattern_ids?.includes(pattern))
  ) return false;
  if (expected.required_invariant_ids !== undefined) {
    const observed = new Set(result.invariant_trace.flatMap((trace) => [
      ...trace.required_invariant_ids,
      ...trace.satisfied_invariant_ids,
    ]));
    if (expected.required_invariant_ids.some((id) => !observed.has(id))) return false;
  }
  return true;
}

async function finalize(
  result: LiveVerificationSummary,
  outputPath: string | undefined,
): Promise<LiveVerificationSummary> {
  if (outputPath === undefined) return result;
  try {
    await writeLiveVerificationSummary(outputPath, result);
    return result;
  } catch {
    return LiveVerificationSummarySchema.parse({
      ...result,
      status: "failed",
      error_category: "summary_write_failed",
    });
  }
}

export async function writeLiveVerificationSummary(
  filePath: string,
  value: LiveVerificationSummary,
): Promise<void> {
  const validated = LiveVerificationSummarySchema.parse(value);
  await atomicWriteJson(filePath, validated, { mode: 0o600, directoryMode: 0o700 });
}

/**
 * Explicit, opt-in live verification. Returned and persisted data is constrained
 * to endpoint metadata, case identifiers/counts, interaction modes, and a fixed
 * error category. Requirements, prompts, model output, facts, and recommendations
 * never enter the summary.
 */
export async function runLiveVerification(
  options: LiveVerificationOptions = {},
): Promise<LiveVerificationSummary> {
  const runTimestamp = timestamp(options.now);
  const inventoryCaseIds = options.caseIds ?? DEFAULT_LIVE_INVENTORY_CASE_IDS;
  const caseIds = selectedCaseIds(options);
  let context: SummaryContext = {
    timestamp: runTimestamp,
    baseUrlSha256: null,
    responsesPathKind: null,
    exactModel: null,
    caseIds,
    modes: [],
  };

  if (options.enabled !== true) {
    return finalize(summary(context, "failed", "explicit_enable_required"), options.outputPath);
  }

  const env = options.env ?? process.env;
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig({
      env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    context = {
      ...context,
      baseUrlSha256: sha256(config.llmBaseUrl),
      exactModel: config.llmModel,
    };
  } catch (error) {
    return finalize(
      summary(context, "failed", classifyError(error, "configuration_error")),
      options.outputPath,
    );
  }

  let client: ResponsesModelClient;
  try {
    client = await ResponsesModelClient.fromEnv({
      env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.cachePath === undefined ? {} : { cachePath: options.cachePath }),
      timeoutMs: options.timeoutMs ?? DEFAULT_LIVE_REQUEST_TIMEOUT_MS,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const probe = await client.probeConnectivity();
    context = {
      ...context,
      responsesPathKind: responsesPathKind(probe.responsesPath),
      exactModel: probe.model,
    };
  } catch (error) {
    return finalize(
      summary(context, "failed", classifyError(error, "configuration_error")),
      options.outputPath,
    );
  }

  let inventoryCases: readonly RegressionCase[];
  try {
    const inventory = await loadRegressionInventoryDirectory(options.inventoryDirectory);
    const selected = selectInventoryCases(inventory.cases, inventoryCaseIds);
    if (selected === undefined) {
      return await finalize(summary(context, "failed", "inventory_error"), options.outputPath);
    }
    inventoryCases = selected;
  } catch {
    return finalize(summary(context, "failed", "inventory_error"), options.outputPath);
  }

  const service = new FoundationAnalysisService({
    modelClient: client,
    store: new InMemoryAnalysisStore(caseIds.length),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const inputs = [
    { id: LIVE_SMOKE_CASE_ID, requirement: LIVE_SMOKE_REQUIREMENT, regressionCase: null },
    ...inventoryCases.map((entry) => ({
      id: entry.id,
      requirement: entry.requirement,
      regressionCase: entry,
    })),
  ];
  const modes: LiveVerificationCaseMode[] = [];
  for (const input of inputs) {
    try {
      const result = await service.analyze({
        request: input.requirement,
        projectRoot: options.cwd ?? process.cwd(),
      });
      modes.push({ case_id: input.id, interaction_mode: result.interaction_mode });
      context = { ...context, modes };
      if (
        input.regressionCase !== null &&
        !matchesReviewedExpectation(result, input.regressionCase)
      ) {
        return await finalize(
          summary(context, "failed", "inventory_expectation_failed"),
          options.outputPath,
        );
      }
    } catch (error) {
      return finalize(
        summary(context, "failed", classifyError(error, "analysis_failed")),
        options.outputPath,
      );
    }
  }

  return finalize(summary(context, "passed", null), options.outputPath);
}
