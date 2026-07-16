import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_LIVE_REQUEST_TIMEOUT_MS,
  runLiveVerification,
  writeLiveVerificationSummary,
  type LiveVerificationSummary,
} from "../../src/live-verification.js";
import { MINIMUM_INVARIANTS_BY_FAMILY } from "../../src/invariant-ids.js";
import { analysis, route } from "../helpers/model-fixtures.js";

function responseFor(text: string, status = 200): Response {
  return new Response(JSON.stringify({
    model: "gpt-5.6-sol",
    output: [{
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
  }), { status, headers: { "content-type": "application/json" } });
}

function environment(configDirectory: string): NodeJS.ProcessEnv {
  return {
    FOUNDATION_CONFIG_DIR: configDirectory,
    FOUNDATION_LLM_API_KEY: "unit-placeholder-key",
    FOUNDATION_LLM_BASE_URL: "https://relay.example/provider",
    FOUNDATION_LLM_RESPONSES_PATH: "/responses",
    FOUNDATION_LLM_MODEL: "gpt-5.6-sol",
    FOUNDATION_LLM_REASONING_EFFORT: "xhigh",
    FOUNDATION_CODE_SHARING: "none",
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("explicit live provider verification harness", () => {
  it("uses a longer request budget only for explicit live verification", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "foundation-live-timeout-"));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(
      new Response("unauthorized", { status: 401 }),
    ));

    await runLiveVerification({
      enabled: true,
      env: environment(directory),
      fetch,
      cwd: directory,
    });
    expect(timeout).toHaveBeenCalledWith(DEFAULT_LIVE_REQUEST_TIMEOUT_MS);

    timeout.mockClear();
    await runLiveVerification({
      enabled: true,
      env: environment(directory),
      fetch,
      cwd: directory,
      timeoutMs: 17,
    });
    expect(timeout).toHaveBeenCalledWith(17);
    timeout.mockRestore();
  });

  it("is closed by default before configuration, credentials, or network are touched", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => {
      throw new Error("network must remain disabled");
    });

    const result = await runLiveVerification({
      env: {
        FOUNDATION_LLM_BASE_URL: "not a URL",
        FOUNDATION_CONFIG_DIR: "/definitely/not/read",
      },
      fetch,
      now: () => new Date("2026-07-15T08:00:00.000Z"),
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toEqual({
      timestamp: "2026-07-15T08:00:00.000Z",
      base_url_sha256: null,
      responses_path_kind: null,
      exact_model: null,
      status: "failed",
      case_ids: [
        "live_smoke_strict_analysis",
        "ordinary_expense_not_specialist_original",
        "offline_continuity_complete_original",
        "money_transfer_initiation_original",
      ],
      case_count: 4,
      completed_case_count: 0,
      interaction_modes: [],
      error_category: "explicit_enable_required",
    });
  });

  it("probes the exact model before a smoke analysis and representative inventory requirements", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "foundation-live-verification-"));
    const managed = analysis([route("managed_online")]);
    const offline = analysis([route("offline_first")]);
    const payment = analysis([route("managed_payment", {
      satisfied_invariant_ids: [
        ...MINIMUM_INVARIANTS_BY_FAMILY.payments,
        ...MINIMUM_INVARIANTS_BY_FAMILY.sensitive,
      ],
      capability_profile: {
        supports_offline_continuity: false,
        requires_continuous_network: true,
        meets_fixed_deadline: true,
        handles_real_payments: true,
        supports_multi_organization: false,
        protects_sensitive_data: true,
      },
    })]);
    const analyses = [managed, managed, offline, payment];
    const requests: Record<string, unknown>[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => {
      if (typeof init?.body !== "string") throw new Error("missing JSON body");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      requests.push(body);
      const next = analyses[requests.length - 2];
      return Promise.resolve(requests.length === 1
        ? responseFor('{"available":true}')
        : responseFor(JSON.stringify(next)));
    });

    const result = await runLiveVerification({
      enabled: true,
      env: environment(directory),
      fetch,
      cachePath: path.join(directory, "endpoint.json"),
      now: () => new Date("2026-07-15T08:30:00.000Z"),
      cwd: directory,
    });

    expect(fetch).toHaveBeenCalledTimes(5);
    expect(requests[0]).toMatchObject({
      model: "gpt-5.6-sol",
      store: false,
      text: { format: { name: "foundation_model_probe", strict: true } },
    });
    for (const request of requests.slice(1)) {
      expect(request).toMatchObject({
        model: "gpt-5.6-sol",
        store: false,
        text: { format: { name: "foundation_analysis", strict: true } },
      });
    }
    expect(result).toEqual({
      timestamp: "2026-07-15T08:30:00.000Z",
      base_url_sha256: sha256("https://relay.example/provider"),
      responses_path_kind: "responses",
      exact_model: "gpt-5.6-sol",
      status: "passed",
      case_ids: [
        "live_smoke_strict_analysis",
        "ordinary_expense_not_specialist_original",
        "offline_continuity_complete_original",
        "money_transfer_initiation_original",
      ],
      case_count: 4,
      completed_case_count: 4,
      interaction_modes: [
        { case_id: "live_smoke_strict_analysis", interaction_mode: "decide" },
        { case_id: "ordinary_expense_not_specialist_original", interaction_mode: "decide" },
        { case_id: "offline_continuity_complete_original", interaction_mode: "decide" },
        { case_id: "money_transfer_initiation_original", interaction_mode: "escalate" },
      ],
      error_category: null,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("relay.example");
    expect(serialized).not.toContain("/provider");
    expect(serialized).not.toContain("Plan the technical foundation");
    expect(serialized).not.toContain("recommendation");
    expect(serialized).not.toContain("facts");
  });

  it("fails when valid structured output violates a reviewed inventory expectation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "foundation-live-expectation-"));
    const generic = analysis([route("managed_online")]);
    let requestCount = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(() => {
      requestCount += 1;
      return Promise.resolve(requestCount === 1
        ? responseFor('{"available":true}')
        : responseFor(JSON.stringify(generic)));
    });

    const result = await runLiveVerification({
      enabled: true,
      env: environment(directory),
      fetch,
      cachePath: path.join(directory, "endpoint.json"),
      cwd: directory,
    });

    expect(result).toMatchObject({
      status: "failed",
      error_category: "inventory_expectation_failed",
    });
    expect(result.case_ids).toHaveLength(4);
    expect(result.completed_case_count).toBeGreaterThan(0);
  });

  it("writes only a fixed failure category when a provider echoes sensitive material", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "foundation-live-failure-"));
    const outputPath = path.join(directory, "summary", "live-provider-verification.json");
    const secret = "sk-provider-echoed-secret";
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(
      new Response(`api_key=${secret}`, { status: 401 }),
    ));

    const result = await runLiveVerification({
      enabled: true,
      env: environment(directory),
      fetch,
      outputPath,
      now: () => new Date("2026-07-15T09:00:00.000Z"),
      cwd: directory,
    });
    const persisted = await readFile(outputPath, "utf8");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "failed",
      error_category: "authentication_failed",
      completed_case_count: 0,
      interaction_modes: [],
    });
    expect(persisted).toBe(`${JSON.stringify(result, null, 2)}\n`);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(persisted).not.toContain(secret);
    if (process.platform !== "win32") {
      expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("reports output-budget exhaustion without persisting provider content", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "foundation-live-budget-"));
    let calls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(() => {
      calls += 1;
      return Promise.resolve(calls === 1
        ? responseFor('{"available":true}')
        : new Response(JSON.stringify({
            model: "gpt-5.6-sol",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output: [],
          }), { status: 200, headers: { "content-type": "application/json" } }));
    });

    const result = await runLiveVerification({
      enabled: true,
      env: environment(directory),
      fetch,
      cwd: directory,
    });

    expect(result).toMatchObject({
      status: "failed",
      error_category: "output_budget_exhausted",
      completed_case_count: 0,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never persists an opaque token embedded in the configured Base URL path", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "foundation-live-url-redaction-"));
    const outputPath = path.join(directory, "summary.json");
    const pathToken = "opaqueSyntheticRouteToken123456789";
    const env = {
      ...environment(directory),
      FOUNDATION_LLM_BASE_URL: `https://relay.example/private/${pathToken}`,
    };
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(
      new Response("unauthorized", { status: 401 }),
    ));

    const result = await runLiveVerification({ enabled: true, env, fetch, outputPath });
    const persisted = await readFile(outputPath, "utf8");

    expect(result.base_url_sha256).toBe(sha256(env.FOUNDATION_LLM_BASE_URL));
    expect(JSON.stringify(result)).not.toContain(pathToken);
    expect(persisted).not.toContain(pathToken);
    expect(persisted).not.toContain("/private/");
    expect(persisted).not.toContain("relay.example");
  });

  it("rejects extra or raw fields at the standalone write boundary", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "foundation-live-summary-"));
    const unsafe = {
      timestamp: "2026-07-15T09:30:00.000Z",
      base_url_sha256: sha256("https://relay.example"),
      responses_path_kind: "responses",
      exact_model: "gpt-5.6-sol",
      status: "failed",
      case_ids: ["live_smoke_strict_analysis"],
      case_count: 1,
      completed_case_count: 0,
      interaction_modes: [],
      error_category: "provider_error",
      raw_model_output: "must never be persisted",
    } as unknown as LiveVerificationSummary;

    await expect(writeLiveVerificationSummary(
      path.join(directory, "unsafe.json"),
      unsafe,
    )).rejects.toThrow();
  });
});
