import { chmod, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  credentialStatus,
  deleteCredential,
  resolveApiKey,
  writeCredential,
} from "../../src/auth.js";
import { createLogger } from "../../src/logger.js";
import { ResponsesModelClient } from "../../src/model-client.js";
import { resolveProjectPath, resolveProjectRoot } from "../../src/project-path.js";
import { redactSensitiveText, sanitizeError } from "../../src/security.js";
import {
  commitFoundation,
  estimateSessionBriefTokens,
  readFoundation,
} from "../../src/state.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "foundation-guard-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("sensitive-data handling", () => {
  it("redacts authorization, bearer, provider, package, cloud, Slack, JWT, and error tokens", () => {
    const source =
      "Authorization: Bearer example-token-value Bearer another.token_value sk-exampleToken123 api_key=plainsecret _authToken=npm_abcdefghijklmnopqrstuvwxyz123456 ghp_abcdefghijklmnopqrstuvwxyz123456 AKIAIOSFODNN7EXAMPLE xoxb-1234567890-abcdefghijk eyJabcdefghijk.abcdefghijkl.abcdefghijkl https://relay-user:relay-password@relay.example/responses";
    const redacted = redactSensitiveText(source);

    expect(redacted).not.toContain("example-token-value");
    expect(redacted).not.toContain("another.token_value");
    expect(redacted).not.toContain("sk-exampleToken123");
    expect(redacted).not.toContain("plainsecret");
    expect(redacted).not.toContain("npm_abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redacted).not.toContain("xoxb-1234567890-abcdefghijk");
    expect(redacted).not.toContain("eyJabcdefghijk.abcdefghijkl.abcdefghijkl");
    expect(redacted).not.toContain("relay-user");
    expect(redacted).not.toContain("relay-password");
    expect(redacted).toContain("https://[REDACTED]@relay.example/responses");
    expect(redacted).toContain("[REDACTED]");
    expect(sanitizeError(new Error(source)).message).toBe(redacted);
  });

  it("logs only to the supplied stderr-like stream and redacts structured fields", () => {
    let output = "";
    const stream = { write: (chunk: string) => { output += chunk; return true; } };
    const logger = createLogger({
      stream: stream as never,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    logger.error("request failed with Bearer token-value", {
      authorization: "Bearer hidden-value",
      nested: "sk-hiddenValue123",
    });

    expect(output).not.toContain("token-value");
    expect(output).not.toContain("hidden-value");
    expect(output).not.toContain("sk-hiddenValue123");
    expect(JSON.parse(output)).toMatchObject({ level: "error", data: { authorization: "[REDACTED]" } });
  });
});

describe("credentials", () => {
  it("writes mode 0600, prefers environment, reports status, and deletes", async () => {
    const directory = await temporaryDirectory();
    const credentialPath = path.join(directory, "nested", "credentials.json");
    await writeCredential("file-key-value", { credentialPath });

    const metadata = await (await import("node:fs/promises")).stat(credentialPath);
    if (process.platform !== "win32") expect(metadata.mode & 0o777).toBe(0o600);
    await expect(resolveApiKey({ credentialPath, env: {} })).resolves.toBe("file-key-value");
    await expect(
      resolveApiKey({ credentialPath, env: { FOUNDATION_LLM_API_KEY: "environment-key" } }),
    ).resolves.toBe("environment-key");
    await expect(credentialStatus({ credentialPath, env: {} })).resolves.toMatchObject({
      configured: true,
      source: "file",
    });
    await expect(deleteCredential({ credentialPath })).resolves.toBe(true);
    await expect(deleteCredential({ credentialPath })).resolves.toBe(false);
  });

  it("refuses a credential file with broad POSIX permissions", async () => {
    if (process.platform === "win32") return;
    const directory = await temporaryDirectory();
    const credentialPath = path.join(directory, "credentials.json");
    await writeCredential("file-key-value", { credentialPath });
    await chmod(credentialPath, 0o644);
    await expect(resolveApiKey({ credentialPath, env: {} })).rejects.toThrow("0600");
  });

  it("falls back to a legacy credential, prefers the new credential, and deletes both managed files", async () => {
    const homeDir = await temporaryDirectory();
    const options = { env: {}, homeDir, platform: process.platform };
    const legacyPath = path.join(homeDir, ".config", "foundation-guard", "credentials.json");
    const currentPath = path.join(homeDir, ".config", "vibe-blueprint", "credentials.json");

    await writeCredential("legacy-file-key", { credentialPath: legacyPath });
    await expect(resolveApiKey(options)).resolves.toBe("legacy-file-key");
    await expect(credentialStatus(options)).resolves.toMatchObject({
      configured: true,
      source: "file",
      credentialFile: legacyPath,
    });

    await writeCredential("current-file-key", options);
    await expect(resolveApiKey(options)).resolves.toBe("current-file-key");
    await expect(credentialStatus(options)).resolves.toMatchObject({ credentialFile: currentPath });
    await expect(deleteCredential(options)).resolves.toBe(true);
    await expect(readFile(currentPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(legacyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(resolveApiKey(options)).resolves.toBeUndefined();
    await expect(deleteCredential(options)).resolves.toBe(false);
  });

  it("keeps environment credentials ahead of both current and legacy files", async () => {
    const homeDir = await temporaryDirectory();
    const options = { env: {}, homeDir, platform: process.platform };
    const legacyPath = path.join(homeDir, ".config", "foundation-guard", "credentials.json");
    await writeCredential("legacy-file-key", { credentialPath: legacyPath });
    await writeCredential("current-file-key", options);

    await expect(resolveApiKey({
      ...options,
      env: { FOUNDATION_LLM_API_KEY: "environment-key" },
    })).resolves.toBe("environment-key");
    await expect(credentialStatus({
      ...options,
      env: { FOUNDATION_LLM_API_KEY: "environment-key" },
    })).resolves.toMatchObject({
      configured: true,
      source: "environment",
      credentialFile: path.join(homeDir, ".config", "vibe-blueprint", "credentials.json"),
    });
  });

  it("keeps an explicit FOUNDATION_CONFIG_DIR isolated from the legacy platform path", async () => {
    const homeDir = await temporaryDirectory();
    const explicitDirectory = path.join(homeDir, "explicit-config");
    const legacyPath = path.join(homeDir, ".config", "foundation-guard", "credentials.json");
    const options = {
      env: { FOUNDATION_CONFIG_DIR: explicitDirectory },
      homeDir,
      platform: process.platform,
    };
    await writeCredential("legacy-file-key", { credentialPath: legacyPath });

    await expect(resolveApiKey(options)).resolves.toBeUndefined();
    await expect(credentialStatus(options)).resolves.toMatchObject({
      configured: false,
      credentialFile: path.join(explicitDirectory, "credentials.json"),
    });
    await expect(deleteCredential(options)).resolves.toBe(false);
    await expect(readFile(legacyPath, "utf8")).resolves.toContain("legacy-file-key");
  });

  it("lets the runtime model client use a legacy credential without migrating or exposing it", async () => {
    const xdgConfigHome = await temporaryDirectory();
    const legacyPath = path.join(xdgConfigHome, "foundation-guard", "credentials.json");
    const currentPath = path.join(xdgConfigHome, "vibe-blueprint", "credentials.json");
    await writeCredential("legacy-runtime-key", { credentialPath: legacyPath });
    let authorization = "";
    const fetch = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Promise.resolve(new Response(JSON.stringify({
        model: "gpt-5.6-sol",
        output: [{
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: '{"available":true}', annotations: [] }],
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    };
    const client = await ResponsesModelClient.fromEnv({
      env: {
        XDG_CONFIG_HOME: xdgConfigHome,
        FOUNDATION_LLM_BASE_URL: "https://relay.example",
        FOUNDATION_LLM_RESPONSES_PATH: "/responses",
      },
      fetch,
    });

    await expect(client.probeConnectivity()).resolves.toMatchObject({
      responsesPath: "/responses",
      model: "gpt-5.6-sol",
    });
    expect(authorization).toBe(`Bearer ${["legacy", "runtime", "key"].join("-")}`);
    await expect(readFile(legacyPath, "utf8")).resolves.toContain("legacy-runtime-key");
    await expect(readFile(currentPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("project path boundary", () => {
  it("canonicalizes project roots and rejects traversal and outside roots", async () => {
    const allowed = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const project = path.join(allowed, "project");
    await (await import("node:fs/promises")).mkdir(project);

    await expect(resolveProjectRoot(project, { allowedRoots: [allowed] })).resolves.toBe(
      await (await import("node:fs/promises")).realpath(project),
    );
    await expect(resolveProjectRoot(outside, { allowedRoots: [allowed] })).rejects.toThrow(
      "outside FOUNDATION_ALLOWED_ROOTS",
    );
    await expect(resolveProjectPath(project, "../escape.json", { allowedRoots: [allowed] })).rejects.toThrow(
      "escapes project_root",
    );
  });

  it("rejects an artifact path that escapes through a symlink", async () => {
    const allowed = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const project = path.join(allowed, "project");
    await (await import("node:fs/promises")).mkdir(project);
    await symlink(outside, path.join(project, "linked"));

    await expect(resolveProjectPath(project, "linked/state.json", { allowedRoots: [allowed] })).rejects.toThrow(
      "symlink",
    );
  });

  it("rejects an in-project artifact symlink instead of overwriting application source", async () => {
    const project = await temporaryDirectory();
    const source = path.join(project, "business-source.ts");
    await writeFile(source, "export const preserved = true;\n");
    await symlink(source, path.join(project, "PROJECT-FOUNDATION.md"));

    await expect(commitFoundation(project, { project_summary: "test" }, { allowedRoots: [project] }))
      .rejects.toThrow("symbolic links");
    await expect(readFile(source, "utf8")).resolves.toBe("export const preserved = true;\n");
  });
});

describe("Foundation state", () => {
  it("atomically creates canonical and generated artifacts and serializes concurrent revisions", async () => {
    const project = await temporaryDirectory();
    const options = { allowedRoots: [project], now: () => new Date("2026-01-01T00:00:00.000Z") };
    const first = await commitFoundation(project, {
      project_summary: "A guarded project",
      decisions: [{ decision: "modular monolith" }],
      included_capabilities: ["accounts"],
    }, options);
    expect(first.revision).toBe(1);

    const concurrent = await Promise.all([
      commitFoundation(project, { assumptions: ["small team"] }, options),
      commitFoundation(project, { excluded_capabilities: ["offline"] }, options),
    ]);
    expect(concurrent.map((result) => result.revision).sort()).toEqual([2, 3]);
    const state = await readFoundation(project, options);
    expect(state?.revision).toBe(3);
    expect(state?.source_hash).toMatch(/^[0-9a-f]{64}$/u);

    await expect(readFile(path.join(project, "PROJECT-FOUNDATION.md"), "utf8")).resolves.toContain(
      "# Project Foundation",
    );
    await expect(readFile(path.join(project, ".project-foundation", "session-brief.md"), "utf8")).resolves.toContain(
      "Foundation Session Brief",
    );
    await expect(readFile(path.join(project, ".project-foundation", "evidence.json"), "utf8")).resolves.toContain(
      '"records": []',
    );
    const entries = (await readFile(path.join(project, ".project-foundation", "decisions.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(entries).toHaveLength(3);
    expect((await readdir(path.join(project, ".project-foundation"))).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("redacts secrets before persistence and rejects tampered state hashes", async () => {
    const project = await temporaryDirectory();
    const options = { allowedRoots: [project] };
    await commitFoundation(project, { project_summary: "Authorization: Bearer secret-token-value sk-secretvalue" }, options);
    const statePath = path.join(project, ".project-foundation", "foundation.json");
    const raw = await readFile(statePath, "utf8");
    expect(raw).not.toContain("secret-token-value");
    expect(raw).not.toContain("sk-secretvalue");
    const state = JSON.parse(raw) as Record<string, unknown>;
    state.project_summary = "tampered";
    await writeFile(statePath, JSON.stringify(state));
    await expect(readFoundation(project, options)).rejects.toThrow("source_hash");
  });

  it("keeps a CJK-heavy Session Brief under a conservative 1000-token ceiling", async () => {
    const project = await temporaryDirectory();
    const repeatedChinese = "这是一个包含多组织、离线同步、敏感数据和发布约束的项目说明。".repeat(300);
    await commitFoundation(project, {
      project_summary: repeatedChinese,
      architecture: { description: repeatedChinese },
      technology_stack: { description: repeatedChinese },
      included_capabilities: Array.from({ length: 30 }, () => repeatedChinese),
      reassessment_triggers: Array.from({ length: 30 }, () => repeatedChinese),
    }, { allowedRoots: [project] });

    const brief = await readFile(
      path.join(project, ".project-foundation", "session-brief.md"),
      "utf8",
    );
    expect(brief).toContain("Foundation Session Brief");
    expect(brief).toContain("Middle detail omitted");
    expect(brief).toContain("Source hash:");
    expect(estimateSessionBriefTokens(brief)).toBeLessThanOrEqual(900);
  });
});
