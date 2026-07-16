import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { PACKAGE_NAME, TOOL_NAMES } from "../../src/constants.js";
import { MINIMUM_INVARIANTS_BY_FAMILY } from "../../src/invariant-ids.js";
import { analysis, route } from "../helpers/model-fixtures.js";

const execFileAsync = promisify(execFile);
const transports: StdioClientTransport[] = [];
const EXPECTED_BIN_TARGETS = Object.freeze({
  "vibe-blueprint": "dist/cli.js",
  "foundation-guard": "dist/cli.js",
  "vibe-blueprint-mcp": "dist/server.js",
  "foundation-guard-mcp": "dist/server.js",
});
type InstalledBinName = keyof typeof EXPECTED_BIN_TARGETS;

interface PackedGlobalShape {
  readonly packageDirectory: string;
  readonly unrelatedCwd: string;
  readonly packedPaths: ReadonlySet<string>;
  readonly installedCli: string;
  readonly installedBins: Readonly<Record<InstalledBinName, string>>;
}

async function createPackedGlobalShape(): Promise<PackedGlobalShape> {
  const staging = await mkdtemp(path.join(os.tmpdir(), "foundation-packed-shape-"));
  const packDirectory = path.join(staging, "pack");
  const prefix = path.join(staging, "prefix");
  const packageDirectory = path.join(prefix, "lib", "node_modules", "vibe-blueprint-mcp");
  const binDirectory = path.join(prefix, "bin");
  const unrelatedCwd = path.join(staging, "unrelated-cwd");
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(prefix, { recursive: true }),
    mkdir(unrelatedCwd, { recursive: true }),
  ]);

  const packed = await execFileAsync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory],
    { cwd: path.resolve("."), env: { ...process.env, npm_config_offline: "true" } },
  );
  const packResult = JSON.parse(packed.stdout) as Array<{
    readonly filename: string;
    readonly files: readonly { readonly path: string }[];
  }>;
  const artifact = packResult[0];
  if (artifact === undefined) throw new Error("npm pack produced no artifact");

  await execFileAsync("npm", [
    "install",
    "--global",
    "--prefix", prefix,
    "--ignore-scripts",
    "--offline",
    path.join(packDirectory, artifact.filename),
  ], { cwd: unrelatedCwd, env: { ...process.env, npm_config_offline: "true" } });
  const manifest = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8")) as {
    readonly bin?: Readonly<Record<string, string>>;
  };
  const installedBins = {} as Record<InstalledBinName, string>;
  for (const [name, expectedTarget] of Object.entries(EXPECTED_BIN_TARGETS) as Array<
    [InstalledBinName, (typeof EXPECTED_BIN_TARGETS)[InstalledBinName]]
  >) {
    if (manifest.bin?.[name] !== expectedTarget) {
      throw new Error(`Packed bin ${name} does not target ${expectedTarget}`);
    }
    const executable = path.join(binDirectory, name);
    installedBins[name] = executable;
    if (await realpath(executable) !== await realpath(path.join(packageDirectory, expectedTarget))) {
      throw new Error(`npm installed ${name} with an unexpected target`);
    }
  }

  return {
    packageDirectory,
    unrelatedCwd,
    packedPaths: new Set(artifact.files.map((file) => file.path)),
    installedCli: installedBins["vibe-blueprint"],
    installedBins,
  };
}

function parseToolResult(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const value = result as { readonly isError?: boolean; readonly content: readonly unknown[] };
  expect(value.isError).not.toBe(true);
  const item = value.content[0] as { readonly type?: unknown; readonly text?: unknown } | undefined;
  if (item?.type !== "text" || typeof item.text !== "string") throw new Error("Expected an MCP text result");
  return JSON.parse(item.text) as unknown;
}

async function git(root: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: root });
}

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
});

describe("installed-shape stdio MCP", () => {
  it("runs both CLI names and both MCP names from the packed bin manifest", async () => {
    const { installedBins, unrelatedCwd } = await createPackedGlobalShape();
    for (const name of ["vibe-blueprint", "foundation-guard"] as const) {
      const help = await execFileAsync(installedBins[name], ["--help"], {
        cwd: unrelatedCwd,
        env: { ...process.env, FOUNDATION_LLM_API_KEY: "" },
      });
      expect(help.stderr).toBe("");
      expect(help.stdout).toContain("Vibe Blueprint CLI");
      expect(help.stdout).toContain("vibe-blueprint auth set");
      expect(help.stdout).not.toContain("foundation-guard auth");
    }

    for (const name of ["vibe-blueprint-mcp", "foundation-guard-mcp"] as const) {
      const configDirectory = await mkdtemp(path.join(os.tmpdir(), "vibe-blueprint-bin-config-"));
      const transport = new StdioClientTransport({
        command: installedBins[name],
        cwd: unrelatedCwd,
        stderr: "pipe",
        env: {
          ...getDefaultEnvironment(),
          FOUNDATION_ALLOWED_ROOTS: unrelatedCwd,
          FOUNDATION_CONFIG_DIR: configDirectory,
        },
      });
      transports.push(transport);
      const client = new Client({ name: "packed-bin-e2e", version: "1.0.0" });
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe(PACKAGE_NAME);
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(
        [...TOOL_NAMES].sort(),
      );
    }
  });

  it("loads packaged decision resources from a global-like npm pack shape and unrelated cwd", async () => {
    const { packageDirectory, unrelatedCwd, packedPaths } = await createPackedGlobalShape();
    expect(packedPaths.has("docs/releases/live-provider-verification.json")).toBe(false);
    expect(packedPaths.has("docs/releases/decision-integrity.md")).toBe(true);
    for (const requiredPath of [
      "resources/architecture-patterns.json",
      "resources/activity-risk-rules.json",
      "resources/regression-inventory/01-known-defects.json",
      "resources/regression-inventory/02-risk-boundaries.json",
      "resources/regression-inventory/03-pattern-boundaries.json",
      "resources/regression-inventory/04-route-and-adversarial.json",
      "dist/pattern-registry.js",
      "dist/activity-risk.js",
      "dist/regression-inventory.js",
    ]) expect(packedPaths.has(requiredPath), requiredPath).toBe(true);

    const probe = `import { pathToFileURL } from "node:url";
const packageRoot = process.argv[1];
const api = await import(pathToFileURL(packageRoot + "/dist/index.js").href);
const patterns = api.loadArchitecturePatternRegistry();
const activity = api.loadActivityRiskRules();
const inventory = await api.loadRegressionInventoryDirectory();
const coverage = api.createRegressionInventoryCoverageReport(inventory);
process.stdout.write(JSON.stringify({
  cwd: process.cwd(),
  patternCount: patterns.patterns.length,
  invariantFamilyCount: patterns.invariant_families.length,
  activityRuleCount: activity.rules.length,
  reviewedFamilies: coverage.reviewed_family_count,
  derivedVariants: coverage.derived_variant_count,
  missingCategories: coverage.missing_required_categories,
  patternResource: api.DEFAULT_ARCHITECTURE_PATTERN_RESOURCE_PATH,
  activityResource: api.DEFAULT_ACTIVITY_RISK_RULES_PATH,
  inventoryResource: api.DEFAULT_REGRESSION_INVENTORY_DIRECTORY
}));`;
    const loaded = await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", probe, packageDirectory],
      { cwd: unrelatedCwd, env: { ...process.env, FOUNDATION_LLM_API_KEY: "" } },
    );
    expect(loaded.stderr).toBe("");
    const result = JSON.parse(loaded.stdout) as Record<string, unknown>;
    expect(await realpath(String(result.cwd))).toBe(await realpath(unrelatedCwd));
    expect(result).toMatchObject({
      patternCount: 5,
      invariantFamilyCount: 5,
      activityRuleCount: 7,
      reviewedFamilies: 36,
      derivedVariants: 8,
      missingCategories: [],
    });
    for (const key of ["patternResource", "activityResource", "inventoryResource"] as const) {
      expect(result[key]).toEqual(expect.stringContaining(packageDirectory));
    }
  });

  it("uses and deletes pre-rename credentials through installed CLI aliases without revealing them", async () => {
    const { installedBins, unrelatedCwd } = await createPackedGlobalShape();
    const xdgConfigHome = await mkdtemp(path.join(os.tmpdir(), "vibe-blueprint-credential-e2e-"));
    const currentDirectory = path.join(xdgConfigHome, "vibe-blueprint");
    const legacyDirectory = path.join(xdgConfigHome, "foundation-guard");
    const currentPath = path.join(currentDirectory, "credentials.json");
    const legacyPath = path.join(legacyDirectory, "credentials.json");
    const currentKey = ["current", "packed", "credential"].join("-");
    const legacyKey = ["legacy", "packed", "credential"].join("-");
    await Promise.all([
      mkdir(currentDirectory, { recursive: true, mode: 0o700 }),
      mkdir(legacyDirectory, { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([
      writeFile(currentPath, JSON.stringify({ version: 1, api_key: currentKey }), { mode: 0o600 }),
      writeFile(legacyPath, JSON.stringify({ version: 1, api_key: legacyKey }), { mode: 0o600 }),
    ]);
    const environment = { ...process.env, XDG_CONFIG_HOME: xdgConfigHome, FOUNDATION_LLM_API_KEY: "" };

    for (const name of ["vibe-blueprint", "foundation-guard"] as const) {
      const status = await execFileAsync(installedBins[name], ["auth", "status"], {
        cwd: unrelatedCwd,
        env: environment,
      });
      expect(status.stderr).toBe("");
      expect(status.stdout).not.toContain(currentKey);
      expect(status.stdout).not.toContain(legacyKey);
      expect(JSON.parse(status.stdout)).toMatchObject({
        configured: true,
        source: "file",
        credentialFile: currentPath,
      });
    }

    const deleted = await execFileAsync(installedBins["foundation-guard"], ["auth", "delete"], {
      cwd: unrelatedCwd,
      env: environment,
    });
    expect(deleted.stderr).toBe("");
    expect(deleted.stdout).not.toContain(currentKey);
    expect(deleted.stdout).not.toContain(legacyKey);
    expect(JSON.parse(deleted.stdout)).toEqual({ deleted: true });
    await expect(readFile(currentPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(legacyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps installed CLI Doctor results on stdout with strict requested-check exit semantics", async () => {
    const { installedCli, packageDirectory, unrelatedCwd } = await createPackedGlobalShape();
    const root = await mkdtemp(path.join(os.tmpdir(), "foundation-cli-doctor-root-"));
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), "foundation-cli-doctor-config-"));
    const relay = createServer((_request, serverResponse) => {
      serverResponse.writeHead(200, { "content-type": "application/json" });
      serverResponse.end(JSON.stringify({
        model: "gpt-5.6-sol",
        output: [{
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: '{"available":true}', annotations: [] }],
        }],
      }));
    });
    relay.listen(0, "127.0.0.1");
    await once(relay, "listening");
    const address = relay.address();
    if (address === null || typeof address === "string") throw new Error("Mock relay did not bind TCP");

    const baseEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      FOUNDATION_ALLOWED_ROOTS: root,
      FOUNDATION_CONFIG_DIR: configDirectory,
      FOUNDATION_LLM_BASE_URL: `http://127.0.0.1:${address.port}`,
      FOUNDATION_LLM_RESPONSES_PATH: "/responses",
      FOUNDATION_LLM_MODEL: "gpt-5.6-sol",
    };
    try {
      expect(await realpath(installedCli)).toBe(
        await realpath(path.join(packageDirectory, "dist", "cli.js")),
      );
      const help = await execFileAsync(installedCli, ["--help"], {
        cwd: unrelatedCwd,
        env: baseEnvironment,
      });
      expect(help.stderr).toBe("");
      expect(help.stdout).toContain("Vibe Blueprint CLI");
      expect(help.stdout).toContain("vibe-blueprint auth set");
      expect(help.stdout).not.toContain("foundation-guard auth");
      const success = await execFileAsync(
        installedCli,
        ["doctor", root, "--check-model"],
        { cwd: unrelatedCwd, env: { ...baseEnvironment, FOUNDATION_LLM_API_KEY: "test-key-placeholder" } },
      );
      expect(success.stderr).toBe("");
      const successfulResult = JSON.parse(success.stdout) as {
        readonly ok: boolean;
        readonly checks: readonly Record<string, unknown>[];
      };
      expect(successfulResult.ok).toBe(true);
      expect(successfulResult.checks).toContainEqual(expect.objectContaining({
        name: "model_connectivity",
        status: "pass",
        outcome: "verified",
        reason: "probe_succeeded",
      }));

      const withoutCredential = { ...baseEnvironment };
      delete withoutCredential.FOUNDATION_LLM_API_KEY;
      let failure: { readonly code: number; readonly stdout: string; readonly stderr: string };
      try {
        await execFileAsync(
          installedCli,
          ["doctor", root, "--check-model"],
          { cwd: unrelatedCwd, env: withoutCredential },
        );
        throw new Error("Expected requested Doctor check without credentials to fail");
      } catch (error) {
        failure = error as { readonly code: number; readonly stdout: string; readonly stderr: string };
      }
      expect(failure.code).toBe(1);
      expect(failure.stderr).toBe("");
      const failedResult = JSON.parse(failure.stdout) as {
        readonly ok: boolean;
        readonly checks: readonly Record<string, unknown>[];
      };
      expect(failedResult.ok).toBe(false);
      const missingCredentialCheck = failedResult.checks.find((check) => check.name === "model_connectivity");
      expect(missingCredentialCheck).toMatchObject({
        name: "model_connectivity",
        status: "fail",
        outcome: "failed",
        reason: "missing_credential",
      });
      const recovery = missingCredentialCheck?.recovery_action as Record<string, unknown> | undefined;
      expect(recovery?.type).toBe("configure_credential");
      expect(recovery?.command).toEqual(["vibe-blueprint", "auth", "set"]);
    } finally {
      relay.close();
      await once(relay, "close");
    }
  });

  it("runs the opt-in live verifier from the packed installed shape and writes only sanitized metadata", async () => {
    const { installedCli, unrelatedCwd } = await createPackedGlobalShape();
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), "foundation-cli-live-config-"));
    const outputPath = path.join(configDirectory, "release", "live-provider-verification.json");
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
    const requestBodies: Record<string, unknown>[] = [];
    const relay = createServer((request, serverResponse) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        requestBodies.push(body);
        const format = body.text as { readonly format?: { readonly name?: string } } | undefined;
        const input = typeof body.input === "string" ? body.input : "";
        const text = format?.format?.name === "foundation_model_probe"
          ? '{"available":true}'
          : JSON.stringify(input.includes("without a network")
              ? offline
              : input.includes("real bank transfer")
                ? payment
                : managed);
        serverResponse.writeHead(200, { "content-type": "application/json" });
        serverResponse.end(JSON.stringify({
          model: "gpt-5.6-sol",
          output: [{
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          }],
        }));
      });
    });
    relay.listen(0, "127.0.0.1");
    await once(relay, "listening");
    const address = relay.address();
    if (address === null || typeof address === "string") throw new Error("Mock relay did not bind TCP");

    const environment = {
      ...process.env,
      FOUNDATION_CONFIG_DIR: configDirectory,
      FOUNDATION_LLM_API_KEY: "test-key-placeholder",
      FOUNDATION_LLM_BASE_URL: `http://127.0.0.1:${address.port}`,
      FOUNDATION_LLM_RESPONSES_PATH: "/responses",
      FOUNDATION_LLM_MODEL: "gpt-5.6-sol",
      FOUNDATION_LLM_REASONING_EFFORT: "xhigh",
      FOUNDATION_CODE_SHARING: "none",
    };
    try {
      let withoutOptIn: { readonly code: number; readonly stdout: string; readonly stderr: string };
      try {
        await execFileAsync(installedCli, ["live-verify"], { cwd: unrelatedCwd, env: environment });
        throw new Error("Expected live verification without --yes to fail closed");
      } catch (error) {
        withoutOptIn = error as { readonly code: number; readonly stdout: string; readonly stderr: string };
      }
      expect(withoutOptIn.code).toBe(1);
      expect(withoutOptIn.stdout).toBe("");
      expect(withoutOptIn.stderr).toContain("rerun with --yes");
      expect(requestBodies).toHaveLength(0);

      const run = await execFileAsync(
        installedCli,
        ["live-verify", "--yes", "--output", outputPath],
        { cwd: unrelatedCwd, env: environment },
      );
      expect(run.stderr).toBe("");
      expect(requestBodies).toHaveLength(5);
      const result = JSON.parse(run.stdout) as Record<string, unknown>;
      expect(result.base_url_sha256).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u));
      expect(result).toMatchObject({
        responses_path_kind: "responses",
        exact_model: "gpt-5.6-sol",
        status: "passed",
        case_count: 4,
        completed_case_count: 4,
        error_category: null,
      });
      const persisted = await readFile(outputPath, "utf8");
      expect(persisted).toBe(`${JSON.stringify(result, null, 2)}\n`);
      for (const forbidden of [
        "Authorization",
        "test-key-placeholder",
        "requirement",
        "prompt",
        "raw_model_output",
        `127.0.0.1:${address.port}`,
        "facts",
        "recommendation",
      ]) expect(persisted).not.toContain(forbidden);
    } finally {
      relay.close();
      await once(relay, "close");
    }
  });

  it("uses a mock Responses endpoint through initialize, all tools, state, scan, and evidence", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "foundation-stdio-e2e-project-"));
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), "foundation-stdio-e2e-config-"));
    await writeFile(path.join(project, "package.json"), JSON.stringify({ scripts: { evidence: "node --test evidence.test.cjs" } }, null, 2));
    await writeFile(path.join(project, "evidence.test.cjs"), "require('node:test')('minimal evidence', () => {});\n");
    await writeFile(path.join(project, "app.txt"), "initial\n");
    await git(project, "init", "-q");
    await git(project, "config", "user.email", "foundation@example.invalid");
    await git(project, "config", "user.name", "Foundation Test");
    await git(project, "add", ".");
    await git(project, "commit", "-qm", "fixture");

    const response = analysis([route("managed_online")]);
    const requests: Array<{ readonly url: string; readonly body: Record<string, unknown> }> = [];
    const relay = createServer((request, serverResponse) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        requests.push({ url: request.url ?? "", body });
        serverResponse.writeHead(200, { "content-type": "application/json" });
        serverResponse.end(JSON.stringify({
          model: "gpt-5.6-sol",
          output: [{
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: JSON.stringify(response), annotations: [] }],
          }],
        }));
      });
    });
    relay.listen(0, "127.0.0.1");
    await once(relay, "listening");
    const address = relay.address();
    if (address === null || typeof address === "string") throw new Error("Mock relay did not bind TCP");

    try {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve("dist/server.js")],
        cwd: path.resolve("."),
        stderr: "pipe",
        env: {
          ...getDefaultEnvironment(),
          FOUNDATION_LLM_API_KEY: "test-key-placeholder",
          FOUNDATION_LLM_BASE_URL: `http://127.0.0.1:${address.port}`,
          FOUNDATION_LLM_MODEL: "gpt-5.6-sol",
          FOUNDATION_LLM_REASONING_EFFORT: "xhigh",
          FOUNDATION_ALLOWED_ROOTS: project,
          FOUNDATION_CODE_SHARING: "none",
          FOUNDATION_CONFIG_DIR: configDirectory,
        },
      });
      transports.push(transport);
      let stderr = "";
      transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      const client = new Client({ name: "black-box-e2e", version: "1.0.0" });
      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(8);
      const analyzed = parseToolResult(await client.callTool({
        name: "foundation_analyze_project",
        arguments: { project_root: project, requirement: "Build a small scheduling Web app." },
      })) as { readonly analysis_id: string; readonly interaction_mode: string };
      expect(analyzed.interaction_mode).toBe("decide");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("/responses");
      expect(requests[0]?.body).toMatchObject({ model: "gpt-5.6-sol", store: false, reasoning: { effort: "xhigh" } });

      const committed = parseToolResult(await client.callTool({
        name: "foundation_commit",
        arguments: {
          project_root: project,
          analysis_id: analyzed.analysis_id,
          evidence_checks: [{ id: "minimal", command: "npm", args: ["run", "evidence"] }],
        },
      })) as { readonly revision: number };
      expect(committed.revision).toBe(1);

      for (const format of ["json", "markdown", "session-brief"] as const) {
        const obtained = parseToolResult(await client.callTool({
          name: "foundation_get",
          arguments: { project_root: project, format },
        }));
        expect(obtained).toBeTruthy();
      }

      await writeFile(path.join(project, "billing.ts"), "import Stripe from 'stripe';\nexport const checkout = stripe.checkout.sessions.create;\n");
      await writeFile(path.join(project, "package.json"), JSON.stringify({
        scripts: { evidence: "node --test evidence.test.cjs" },
        dependencies: { stripe: "install-time-stable" },
      }, null, 2));
      const scanned = parseToolResult(await client.callTool({
        name: "foundation_scan_changes",
        arguments: { project_root: project },
      })) as { readonly findings: { readonly payment: { readonly confidence: string } } };
      expect(scanned.findings.payment.confidence).toBe("high");

      const verified = parseToolResult(await client.callTool({
        name: "foundation_verify",
        arguments: { project_root: project, check_id: "minimal", mode: "run" },
      })) as { readonly record: { readonly status: string } };
      expect(verified.record.status).toBe("passed");
      expect(await readFile(path.join(project, "PROJECT-FOUNDATION.md"), "utf8")).toContain("# Project Foundation");
      expect(stderr).toContain("Vibe Blueprint MCP started");
    } finally {
      relay.close();
      await once(relay, "close");
    }
  });
});
