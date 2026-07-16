import { describe, expect, it } from "vitest";

import path from "node:path";

import {
  getConfigDiagnostics,
  getCredentialFilePath,
  getLegacyCredentialFilePath,
  getUserConfigDir,
  loadConfig,
} from "../../src/config.js";

describe("Vibe Blueprint model configuration", () => {
  it("uses Vibe Blueprint platform paths while preserving explicit FOUNDATION_CONFIG_DIR", () => {
    const homeDir = path.resolve("fixture-home");
    expect(getUserConfigDir({ env: {}, homeDir, platform: "darwin" })).toBe(
      path.join(homeDir, ".config", "vibe-blueprint"),
    );
    expect(getCredentialFilePath({ env: {}, homeDir, platform: "darwin" })).toBe(
      path.join(homeDir, ".config", "vibe-blueprint", "credentials.json"),
    );
    expect(getLegacyCredentialFilePath({ env: {}, homeDir, platform: "darwin" })).toBe(
      path.join(homeDir, ".config", "foundation-guard", "credentials.json"),
    );

    const explicit = path.resolve("fixture-explicit-config");
    const options = { env: { FOUNDATION_CONFIG_DIR: explicit }, homeDir, platform: "darwin" as const };
    expect(getUserConfigDir(options)).toBe(explicit);
    expect(getCredentialFilePath(options)).toBe(path.join(explicit, "credentials.json"));
    expect(getLegacyCredentialFilePath(options)).toBeUndefined();
  });

  it("rejects remote cleartext HTTP but permits address-literal loopback HTTP for tests", () => {
    expect(() => loadConfig({
      env: { FOUNDATION_LLM_BASE_URL: "http://relay.example" },
    })).toThrow(/must use HTTPS.*loopback test server/iu);
    expect(loadConfig({
      env: { FOUNDATION_LLM_BASE_URL: "http://127.0.0.1:43123" },
    }).llmBaseUrl).toBe("http://127.0.0.1:43123");
    expect(loadConfig({
      env: { FOUNDATION_LLM_BASE_URL: "http://[::1]:43123" },
    }).llmBaseUrl).toBe("http://[::1]:43123");
    expect(() => loadConfig({
      env: { FOUNDATION_LLM_BASE_URL: "http://localhost:43123" },
    })).toThrow(/must use HTTPS/iu);
  });

  it("rejects Base URL userinfo without echoing it in diagnostics", () => {
    const baseUrl = "https://relay-user:relay-password@relay.example";
    const env = { FOUNDATION_LLM_BASE_URL: baseUrl };

    expect(() => loadConfig({ env })).toThrow(/must not contain credentials/iu);
    const diagnostics = getConfigDiagnostics({ env });
    const serialized = JSON.stringify(diagnostics);
    expect(diagnostics.ok).toBe(false);
    expect(serialized).not.toContain("relay-user");
    expect(serialized).not.toContain("relay-password");
  });
});
