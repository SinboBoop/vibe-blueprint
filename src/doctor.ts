import { access } from "node:fs/promises";
import { z } from "zod";

import { credentialStatus } from "./auth.js";
import { getConfigDiagnostics, type LoadConfigOptions } from "./config.js";
import { CLI_NAME } from "./constants.js";
import { resolveProjectRoot } from "./project-path.js";
import { readFoundation } from "./state.js";
import { safeErrorMessage } from "./security.js";

export const ModelCheckOutcomeSchema = z.enum([
  "verified",
  "failed",
  "not_requested",
]);

export const ModelCheckReasonSchema = z.enum([
  "probe_succeeded",
  "not_requested",
  "missing_credential",
  "probe_unavailable",
  "timeout",
  "endpoint_unavailable",
  "authentication_failed",
  "model_rejected",
  "model_mismatch",
  "invalid_structured_output",
  "network_error",
  "probe_failed",
]);

export const DoctorRecoveryActionTypeSchema = z.enum([
  "configure_credential",
  "repair_installation",
  "check_connectivity",
  "check_endpoint_configuration",
  "check_authentication",
  "check_model_configuration",
  "check_provider_compatibility",
  "retry_model_check",
]);

export const DoctorRecoveryActionSchema = z
  .object({
    type: DoctorRecoveryActionTypeSchema,
    description: z.string().min(1),
    command: z.array(z.string().min(1)).min(1).nullable(),
  })
  .strict();

export type ModelCheckOutcome = z.infer<typeof ModelCheckOutcomeSchema>;
export type ModelCheckReason = z.infer<typeof ModelCheckReasonSchema>;
export type DoctorRecoveryAction = z.infer<typeof DoctorRecoveryActionSchema>;

export interface DoctorCheck {
  readonly name: string;
  readonly status: "pass" | "warn" | "fail" | "skipped";
  readonly detail: string;
  /** Additive machine-readable metadata present for model_connectivity. */
  readonly outcome?: ModelCheckOutcome;
  readonly reason?: ModelCheckReason;
  readonly recovery_action?: DoctorRecoveryAction | null;
}

export interface DoctorOptions extends LoadConfigOptions {
  readonly projectRoot?: string;
  readonly checkModel?: boolean;
  readonly probeModel?: () => Promise<{ readonly endpoint: string; readonly model: string }>;
}

export interface DoctorResult {
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
  readonly configuration: ReturnType<typeof getConfigDiagnostics>["effective"];
  readonly foundationExists: boolean | null;
  readonly protectionCoverage: unknown;
}

function recoveryAction(
  type: DoctorRecoveryAction["type"],
  description: string,
  command: readonly string[] | null = null,
): DoctorRecoveryAction {
  return DoctorRecoveryActionSchema.parse({ type, description, command });
}

function failedModelCheck(
  reason: Exclude<ModelCheckReason, "probe_succeeded" | "not_requested">,
  detail: string,
  recovery: DoctorRecoveryAction,
): DoctorCheck {
  return {
    name: "model_connectivity",
    status: "fail",
    outcome: "failed",
    reason,
    detail: safeErrorMessage(new Error(detail)),
    recovery_action: recovery,
  };
}

function errorStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function classifyProbeFailure(error: unknown): DoctorCheck {
  const detail = safeErrorMessage(error);
  const normalized = detail.toLocaleLowerCase("en-US");
  const status = errorStatus(error);

  if (
    /(?:probe (?:was not supplied|is unavailable)|does not expose connectivity probing)/u.test(normalized)
  ) {
    return failedModelCheck(
      "probe_unavailable",
      detail,
      recoveryAction(
        "repair_installation",
        "Use a Vibe Blueprint installation or MCP model client that exposes connectivity probing.",
      ),
    );
  }
  if (
    (error instanceof Error && error.name === "TimeoutError") ||
    /(?:timed out|timeout|time-out)/u.test(normalized)
  ) {
    return failedModelCheck(
      "timeout",
      detail,
      recoveryAction(
        "check_connectivity",
        "Verify network access to the configured endpoint, then retry the model check.",
        [CLI_NAME, "doctor", "--check-model"],
      ),
    );
  }
  if (status === 401 || status === 403 || /(?:authentication|unauthorized|forbidden)/u.test(normalized)) {
    return failedModelCheck(
      "authentication_failed",
      detail,
      recoveryAction(
        "check_authentication",
        "Replace or re-authorize the local Vibe Blueprint model credential, then retry.",
        [CLI_NAME, "auth", "set"],
      ),
    );
  }
  if (/model probe reported .*exact configured model/u.test(normalized)) {
    return failedModelCheck(
      "model_mismatch",
      detail,
      recoveryAction(
        "check_model_configuration",
        "Verify the exact Vibe Blueprint model identifier and relay model mapping; no substitute model was accepted.",
      ),
    );
  }
  if (
    /(?:structured|strict(?: response)? schema|invalid json|output text|non-object body)/u.test(normalized)
  ) {
    return failedModelCheck(
      "invalid_structured_output",
      detail,
      recoveryAction(
        "check_provider_compatibility",
        "Verify that the configured relay supports strict Responses structured output.",
      ),
    );
  }
  if (
    /(?:model (?:was )?(?:rejected|unavailable|not found|unsupported)|unknown model|does not exist|invalid model)/u.test(normalized) ||
    ((status === 400 || status === 404 || status === 422) && /model/u.test(normalized))
  ) {
    return failedModelCheck(
      "model_rejected",
      detail,
      recoveryAction(
        "check_model_configuration",
        "Configure a model identifier accepted by the endpoint; Vibe Blueprint will not substitute another model.",
      ),
    );
  }
  if (
    status === 404 ||
    status === 405 ||
    /(?:neither \/responses nor \/v1\/responses|endpoint (?:is )?(?:missing|unavailable)|http 404|http 405)/u.test(normalized)
  ) {
    return failedModelCheck(
      "endpoint_unavailable",
      detail,
      recoveryAction(
        "check_endpoint_configuration",
        "Verify FOUNDATION_LLM_BASE_URL and FOUNDATION_LLM_RESPONSES_PATH, then retry.",
      ),
    );
  }
  if (
    /(?:network|fetch failed|econn|enotfound|socket|connection refused|connection reset)/u.test(normalized)
  ) {
    return failedModelCheck(
      "network_error",
      detail,
      recoveryAction(
        "check_connectivity",
        "Verify DNS, network access, and the configured endpoint, then retry.",
        [CLI_NAME, "doctor", "--check-model"],
      ),
    );
  }
  return failedModelCheck(
    "probe_failed",
    detail,
    recoveryAction(
      "retry_model_check",
      "Review the sanitized diagnostic and retry the exact configured model check.",
      [CLI_NAME, "doctor", "--check-model"],
    ),
  );
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const diagnostics = getConfigDiagnostics(options);
  const checks: DoctorCheck[] = [
    {
      name: "configuration",
      status: diagnostics.ok ? "pass" : "fail",
      detail: diagnostics.ok ? "Configuration is valid" : diagnostics.errors.join("; "),
    },
  ];

  const credential = await credentialStatus(options).catch((error: unknown) => ({
    configured: false as const,
    source: "none" as const,
    credentialFile: diagnostics.effective.credentialFile,
    securePermissions: false,
    detail: safeErrorMessage(error),
  }));
  checks.push({
    name: "credential",
    status: credential.configured ? "pass" : "warn",
    detail: credential.detail,
  });

  for (const root of diagnostics.effective.allowedRoots) {
    try {
      await access(root);
      checks.push({ name: "allowed_root", status: "pass", detail: root });
    } catch (error) {
      checks.push({ name: "allowed_root", status: "fail", detail: `${root}: ${safeErrorMessage(error)}` });
    }
  }

  let foundationExists: boolean | null = null;
  let protectionCoverage: unknown = null;
  if (options.projectRoot !== undefined) {
    try {
      const root = await resolveProjectRoot(options.projectRoot, options);
      const foundation = await readFoundation(root, options);
      foundationExists = foundation !== null;
      protectionCoverage = foundation?.protection_coverage ?? null;
      checks.push({
        name: "foundation_state",
        status: foundation === null ? "warn" : "pass",
        detail: foundation === null ? "No Foundation is committed" : `Foundation revision ${foundation.revision}`,
      });
      checks.push({
        name: "protection_coverage",
        status: foundation === null ? "skipped" : "pass",
        detail: foundation === null ? "No Foundation to inspect" : JSON.stringify(foundation.protection_coverage),
      });
    } catch (error) {
      checks.push({ name: "project_root", status: "fail", detail: safeErrorMessage(error) });
    }
  } else {
    checks.push({ name: "foundation_state", status: "skipped", detail: "No project_root supplied" });
  }

  if (options.checkModel === true) {
    if (!credential.configured) {
      checks.push(failedModelCheck(
        "missing_credential",
        "No Vibe Blueprint model credential is configured; the requested model check was not run.",
        recoveryAction(
          "configure_credential",
          "Store the Vibe Blueprint model credential locally, then retry the requested check.",
          [CLI_NAME, "auth", "set"],
        ),
      ));
    } else if (options.probeModel === undefined) {
      checks.push(failedModelCheck(
        "probe_unavailable",
        "No executable model connectivity probe is available; the requested model check was not run.",
        recoveryAction(
          "repair_installation",
          "Use a Vibe Blueprint installation or MCP model client that exposes connectivity probing.",
        ),
      ));
    } else {
      try {
        const result = await options.probeModel();
        if (result.model !== diagnostics.effective.llmModel) {
          checks.push(failedModelCheck(
            "model_mismatch",
            `Model probe reported ${result.model}, but the exact configured model is ${diagnostics.effective.llmModel}.`,
            recoveryAction(
              "check_model_configuration",
              "Verify the exact Vibe Blueprint model identifier and relay model mapping; no substitute model was accepted.",
            ),
          ));
        } else if (result.endpoint.trim().length === 0 || result.model.trim().length === 0) {
          checks.push(failedModelCheck(
            "invalid_structured_output",
            "Model connectivity probe returned an incomplete result.",
            recoveryAction(
              "check_provider_compatibility",
              "Verify that the configured relay supports strict Responses structured output.",
            ),
          ));
        } else {
          checks.push({
            name: "model_connectivity",
            status: "pass",
            outcome: "verified",
            reason: "probe_succeeded",
            detail: safeErrorMessage(
              new Error(`Responses endpoint ${result.endpoint} accepted model ${result.model}`),
            ),
            recovery_action: null,
          });
        }
      } catch (error) {
        checks.push(classifyProbeFailure(error));
      }
    }
  } else {
    checks.push({
      name: "model_connectivity",
      status: "skipped",
      outcome: "not_requested",
      reason: "not_requested",
      detail: "Connectivity check not requested",
      recovery_action: null,
    });
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks,
    configuration: diagnostics.effective,
    foundationExists,
    protectionCoverage,
  };
}
