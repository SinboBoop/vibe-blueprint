import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runDoctor, type DoctorCheck } from "../../src/doctor.js";

const MODEL = "gpt-5.6-sol";

async function options(): Promise<{
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
}> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "foundation-doctor-root-"));
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "foundation-doctor-home-"));
  return {
    cwd,
    homeDir,
    env: {
      FOUNDATION_ALLOWED_ROOTS: cwd,
      FOUNDATION_LLM_API_KEY: "test-key-placeholder",
      FOUNDATION_LLM_MODEL: MODEL,
    },
  };
}

function modelCheck(checks: readonly DoctorCheck[]): DoctorCheck {
  const check = checks.find((candidate) => candidate.name === "model_connectivity");
  if (check === undefined) throw new Error("Expected model_connectivity check");
  return check;
}

describe("runDoctor strict model diagnostics", () => {
  it("passes only after the exact configured model probe succeeds", async () => {
    const base = await options();
    const result = await runDoctor({
      ...base,
      checkModel: true,
      probeModel: vi.fn(() => Promise.resolve({ endpoint: "/responses", model: MODEL })),
    });

    expect(result.ok).toBe(true);
    expect(modelCheck(result.checks)).toEqual({
      name: "model_connectivity",
      status: "pass",
      outcome: "verified",
      reason: "probe_succeeded",
      detail: `Responses endpoint /responses accepted model ${MODEL}`,
      recovery_action: null,
    });
  });

  it("fails a requested check when the credential is missing without calling the probe", async () => {
    const base = await options();
    const probe = vi.fn(() => Promise.resolve({ endpoint: "/responses", model: MODEL }));
    const result = await runDoctor({
      ...base,
      env: { FOUNDATION_ALLOWED_ROOTS: base.cwd, FOUNDATION_LLM_MODEL: MODEL },
      checkModel: true,
      probeModel: probe,
    });

    expect(probe).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(modelCheck(result.checks)).toMatchObject({
      status: "fail",
      outcome: "failed",
      reason: "missing_credential",
      recovery_action: {
        type: "configure_credential",
        command: ["vibe-blueprint", "auth", "set"],
      },
    });
  });

  it("fails a requested check when no probe is available", async () => {
    const base = await options();
    const result = await runDoctor({ ...base, checkModel: true });

    expect(result.ok).toBe(false);
    expect(modelCheck(result.checks)).toMatchObject({
      status: "fail",
      outcome: "failed",
      reason: "probe_unavailable",
      recovery_action: { type: "repair_installation", command: null },
    });
  });

  it("does not run an unrequested probe and keeps the check non-failing", async () => {
    const base = await options();
    const probe = vi.fn(() => Promise.reject(new Error("must not run")));
    const result = await runDoctor({
      ...base,
      env: { FOUNDATION_ALLOWED_ROOTS: base.cwd, FOUNDATION_LLM_MODEL: MODEL },
      checkModel: false,
      probeModel: probe,
    });

    expect(probe).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(modelCheck(result.checks)).toEqual({
      name: "model_connectivity",
      status: "skipped",
      outcome: "not_requested",
      reason: "not_requested",
      detail: "Connectivity check not requested",
      recovery_action: null,
    });
  });

  it.each([
    {
      label: "timeout",
      error: Object.assign(new Error("request timed out"), { name: "TimeoutError" }),
      reason: "timeout",
      recovery: "check_connectivity",
    },
    {
      label: "endpoint failure",
      error: Object.assign(new Error("Responses endpoint unavailable with HTTP 404"), { status: 404 }),
      reason: "endpoint_unavailable",
      recovery: "check_endpoint_configuration",
    },
    {
      label: "exact-model rejection",
      error: Object.assign(new Error("model unavailable: gpt-5.6-sol"), { status: 400 }),
      reason: "model_rejected",
      recovery: "check_model_configuration",
    },
    {
      label: "invalid structured probe",
      error: new Error("Vibe Blueprint model probe did not match its strict schema"),
      reason: "invalid_structured_output",
      recovery: "check_provider_compatibility",
    },
    {
      label: "missing response model identity",
      error: new Error(
        "Vibe Blueprint model probe did not match its strict response schema: missing top-level model",
      ),
      reason: "invalid_structured_output",
      recovery: "check_provider_compatibility",
    },
    {
      label: "response model mismatch",
      error: new Error(
        "Vibe Blueprint model probe reported actual model substitute-model, but the exact configured model is gpt-5.6-sol",
      ),
      reason: "model_mismatch",
      recovery: "check_model_configuration",
    },
  ])("classifies $label with a stable reason and recovery", async ({ error, reason, recovery }) => {
    const base = await options();
    const result = await runDoctor({
      ...base,
      checkModel: true,
      probeModel: () => Promise.reject(error),
    });

    expect(result.ok).toBe(false);
    expect(modelCheck(result.checks)).toMatchObject({
      status: "fail",
      outcome: "failed",
      reason,
      recovery_action: { type: recovery },
    });
  });

  it("fails when a probe reports a different model", async () => {
    const base = await options();
    const result = await runDoctor({
      ...base,
      checkModel: true,
      probeModel: () => Promise.resolve({ endpoint: "/responses", model: "substitute-model" }),
    });

    expect(result.ok).toBe(false);
    expect(modelCheck(result.checks)).toMatchObject({
      status: "fail",
      outcome: "failed",
      reason: "model_mismatch",
      recovery_action: { type: "check_model_configuration" },
    });
  });

  it("redacts sensitive material in failed probe details and recovery output", async () => {
    const base = await options();
    const secret = "sk-provider-echoed-secret";
    const result = await runDoctor({
      ...base,
      checkModel: true,
      probeModel: () => Promise.reject(new Error(`network failed with api_key=${secret}`)),
    });
    const serialized = JSON.stringify(modelCheck(result.checks));

    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
  });

  it("redacts URL userinfo from successful and failed probe details", async () => {
    const base = await options();
    const successful = await runDoctor({
      ...base,
      checkModel: true,
      probeModel: () => Promise.resolve({
        endpoint: "https://relay-user:relay-password@relay.example/responses",
        model: MODEL,
      }),
    });
    const failed = await runDoctor({
      ...base,
      checkModel: true,
      probeModel: () => Promise.reject(
        new Error("request to https://relay-user:relay-password@relay.example/responses failed"),
      ),
    });

    for (const result of [successful, failed]) {
      const serialized = JSON.stringify(modelCheck(result.checks));
      expect(serialized).not.toContain("relay-user");
      expect(serialized).not.toContain("relay-password");
      expect(serialized).toContain("[REDACTED]");
    }
  });
});
