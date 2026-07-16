import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { FoundationAnalysisService } from "../../src/analysis-service.js";
import { FOUNDATION_SCHEMA_VERSION, PACKAGE_NAME, TOOL_NAMES } from "../../src/constants.js";
import { createFoundationMcpServer } from "../../src/mcp-server.js";
import { ResponsesModelClient, type FoundationModelClient, type ModelAnalysisRequest } from "../../src/model-client.js";
import { DecisionResultSchema, type CandidateRoute, type ModelAnalysis } from "../../src/schemas.js";
import { analysis, fact, route } from "../helpers/model-fixtures.js";

const execFileAsync = promisify(execFile);

function parseResult(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const value = result as { readonly isError?: boolean; readonly content: readonly unknown[] };
  expect(value.isError).not.toBe(true);
  const first = value.content[0] as { readonly type?: unknown; readonly text?: unknown } | undefined;
  expect(first?.type).toBe("text");
  if (first?.type !== "text" || typeof first.text !== "string") throw new Error("Expected text tool result");
  return JSON.parse(first.text) as unknown;
}

class InventoryModel implements FoundationModelClient {
  requests: ModelAnalysisRequest[] = [];

  analyze(input: ModelAnalysisRequest): Promise<ModelAnalysis> {
    this.requests.push(input);
    if (input.answer !== undefined) {
      return Promise.resolve(analysis([route("offline_first")], {
        facts: [fact({ value: false, certainty: "explicit", question: null, constraint_level: "hard", adjustable: false })],
      }));
    }
    return Promise.resolve(analysis([route("managed_online")], { facts: [fact()] }));
  }
}

class SequenceModel implements FoundationModelClient {
  readonly #responses: readonly ModelAnalysis[];
  #index = 0;

  constructor(responses: readonly ModelAnalysis[]) {
    this.#responses = responses;
  }

  analyze(): Promise<ModelAnalysis> {
    const response = this.#responses[this.#index];
    this.#index += 1;
    if (response === undefined) throw new Error("Protocol sequence model exhausted its fixtures");
    return Promise.resolve(response);
  }
}

function durableTradeoff(): CandidateRoute["tradeoff"] {
  return {
    business_owned: true,
    difficult_to_reverse: true,
    high_coupling: false,
    ongoing_cost_or_operations: false,
    winning_scenarios: ["This route wins when its stated business consequence is the priority."],
  };
}

function consequenceRoute(
  id: string,
  dimension: string,
  outcome: string,
  overrides: Partial<CandidateRoute> = {},
): CandidateRoute {
  return route(id, {
    consequences: [{ dimension, outcome, significance: "material", user_visible: true }],
    ...overrides,
  });
}

const FOUNDATION_V1_KEYS = [
  "architecture",
  "assumptions",
  "created_at",
  "decisions",
  "evidence_checks",
  "excluded_capabilities",
  "facts",
  "included_capabilities",
  "project_summary",
  "protection_coverage",
  "reassessment_triggers",
  "revision",
  "risk_state",
  "schema_version",
  "source_hash",
  "technology_stack",
  "undecided_capabilities",
  "updated_at",
] as const;

// Captured in the exact legacy non-abstain wire shape. Keep this independent of
// current fixture builders so additions to current results cannot mask a
// backwards-compatibility regression in the runtime parser.
const LEGACY_V01_DECIDE_JSON = JSON.stringify({
  interaction_mode: "decide",
  facts: [],
  recommendation: "Use a managed modular monolith.",
  major_drawback: "The first deployment depends on a managed platform.",
  key_assumption: "The team prefers low operational overhead.",
  change_condition: "Reassess if offline continuity becomes mandatory.",
  risk_state: {
    level: "low",
    domains: [{
      domain: "general",
      severity: "low",
      requires_escalation: false,
      reason: "No specialist domain is in scope.",
    }],
    reasons: ["Ordinary application risk."],
  },
  proposed_stack: {
    client: {
      choice: "React",
      rationale: "A common browser UI stack.",
      limitation: "Requires JavaScript delivery.",
      replacement_cost: "Moderate UI rewrite.",
    },
    server: {
      choice: "Node.js",
      rationale: "One language across the application.",
      limitation: "CPU-heavy work needs isolation.",
      replacement_cost: "Moderate service rewrite.",
    },
    database: {
      choice: "PostgreSQL",
      rationale: "Durable relational records.",
      limitation: "Requires managed database operations.",
      replacement_cost: "High data migration cost.",
    },
    authentication: {
      choice: "Managed OIDC",
      rationale: "Avoids password custody.",
      limitation: "Depends on an identity provider.",
      replacement_cost: "Moderate identity migration.",
    },
    file_storage: {
      choice: "Object storage",
      rationale: "Separates files from application nodes.",
      limitation: "Needs lifecycle configuration.",
      replacement_cost: "Low to moderate file migration.",
    },
    background_jobs: {
      choice: "Database-backed queue",
      rationale: "Keeps the first system compact.",
      limitation: "Not suited to extreme throughput.",
      replacement_cost: "Moderate queue migration.",
    },
    deployment: {
      choice: "Managed application platform",
      rationale: "Reduces operations work.",
      limitation: "Creates platform dependency.",
      replacement_cost: "Moderate deployment rewrite.",
    },
    testing: {
      choice: "Vitest and browser tests",
      rationale: "Covers logic and core workflows.",
      limitation: "Browser tests need maintenance.",
      replacement_cost: "Low test-runner migration.",
    },
    logging_and_monitoring: {
      choice: "Structured logs and health checks",
      rationale: "Provides basic operational visibility.",
      limitation: "Advanced tracing is deferred.",
      replacement_cost: "Low observability migration.",
    },
    data_migrations_and_backups: {
      choice: "Versioned migrations and managed backups",
      rationale: "Protects durable state.",
      limitation: "Restore drills remain necessary.",
      replacement_cost: "Moderate operational migration.",
    },
    rationale: "A compact managed stack fits the initial product.",
    major_limit: "It depends on managed services.",
    replacement_cost: "Moderate except for persistent data.",
  },
  architecture: {
    pattern: "managed_modular_monolith",
    deployment_shape: "One managed Web service with a managed database.",
    modules: ["Web", "Application", "Persistence"],
    data_flow: "The browser calls the server, which owns database access.",
    failure_strategy: "Fail closed and retry bounded transient operations.",
    security_baseline: "Server-side authorization and encrypted transport.",
    boundaries: ["The server owns all authoritative writes."],
  },
  analysis_id: "00000000-0000-4000-8000-000000000001",
});

describe("MCP protocol workflow", () => {
  const previousRoots = process.env.FOUNDATION_ALLOWED_ROOTS;
  const previousApiKey = process.env.FOUNDATION_LLM_API_KEY;
  const previousModel = process.env.FOUNDATION_LLM_MODEL;

  afterEach(() => {
    if (previousRoots === undefined) delete process.env.FOUNDATION_ALLOWED_ROOTS;
    else process.env.FOUNDATION_ALLOWED_ROOTS = previousRoots;
    if (previousApiKey === undefined) delete process.env.FOUNDATION_LLM_API_KEY;
    else process.env.FOUNDATION_LLM_API_KEY = previousApiKey;
    if (previousModel === undefined) delete process.env.FOUNDATION_LLM_MODEL;
    else process.env.FOUNDATION_LLM_MODEL = previousModel;
  });

  it("returns strict requested model-check outcomes over MCP", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "foundation-mcp-doctor-"));
    process.env.FOUNDATION_ALLOWED_ROOTS = root;
    process.env.FOUNDATION_LLM_API_KEY = "test-key-placeholder";
    process.env.FOUNDATION_LLM_MODEL = "gpt-5.6-sol";

    const probeResponse = new Response(JSON.stringify({
      model: "gpt-5.6-sol",
      output: [{
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: '{"available":true}', annotations: [] }],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
    const probingModel = new ResponsesModelClient({
      apiKey: "test-key-placeholder",
      baseUrl: "https://relay.example",
      responsesPath: "/responses",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      fetch: () => Promise.resolve(probeResponse.clone()),
    });
    const server = createFoundationMcpServer({ modelClient: probingModel });
    const client = new Client({ name: "doctor-integration", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    expect(client.getServerVersion()?.name).toBe(PACKAGE_NAME);

    const verified = parseResult(await client.callTool({
      name: "foundation_doctor",
      arguments: { project_root: root, check_model: true },
    })) as { readonly ok: boolean; readonly checks: readonly Record<string, unknown>[] };
    expect(verified.ok).toBe(true);
    expect(verified.checks).toContainEqual(expect.objectContaining({
      name: "model_connectivity",
      status: "pass",
      outcome: "verified",
      reason: "probe_succeeded",
      recovery_action: null,
    }));
    await client.close();
    await server.close();

    const nonProbingModel = new InventoryModel();
    const nonProbingServer = createFoundationMcpServer({ modelClient: nonProbingModel });
    const nonProbingClient = new Client({ name: "doctor-no-probe-integration", version: "1.0.0" });
    const [nonProbingClientTransport, nonProbingServerTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      nonProbingServer.connect(nonProbingServerTransport),
      nonProbingClient.connect(nonProbingClientTransport),
    ]);
    const unavailable = parseResult(await nonProbingClient.callTool({
      name: "foundation_doctor",
      arguments: { project_root: root, check_model: true },
    })) as { readonly ok: boolean; readonly checks: readonly Record<string, unknown>[] };
    expect(unavailable.ok).toBe(false);
    const unavailableCheck = unavailable.checks.find((check) => check.name === "model_connectivity");
    expect(unavailableCheck).toMatchObject({
      name: "model_connectivity",
      status: "fail",
      outcome: "failed",
      reason: "probe_unavailable",
    });
    const unavailableRecovery = unavailableCheck?.recovery_action as Record<string, unknown> | undefined;
    expect(unavailableRecovery?.type).toBe("repair_installation");
    await nonProbingClient.close();
    await nonProbingServer.close();
  });

  it("initializes, exposes eight tools, analyzes, answers, commits, reads, scans, and verifies", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "foundation-mcp-integration-"));
    process.env.FOUNDATION_ALLOWED_ROOTS = root;
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { evidence: "node evidence.cjs" } }, null, 2));
    await writeFile(path.join(root, "evidence.cjs"), "console.log('evidence passed')\n");
    await writeFile(path.join(root, "billing.ts"), "export const billing = null;\n");
    await chmod(path.join(root, "evidence.cjs"), 0o644);
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "foundation@example.invalid"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Foundation Test"], { cwd: root });
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: root });

    const model = new InventoryModel();
    const service = new FoundationAnalysisService({ modelClient: model });
    const server = createFoundationMcpServer({ modelClient: model, analysisService: service });
    const client = new Client({ name: "foundation-integration", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(8);
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());

    const doctor = parseResult(await client.callTool({ name: "foundation_doctor", arguments: { project_root: root } })) as { ok: boolean; foundationExists: boolean };
    expect(doctor.ok).toBe(true);
    expect(doctor.foundationExists).toBe(false);

    const firstRaw = parseResult(await client.callTool({
      name: "foundation_analyze_project",
      arguments: { project_root: root, requirement: "Field staff may need to work through outages." },
    }));
    const first = DecisionResultSchema.parse(firstRaw);
    expect(first.interaction_mode).toBe("confirm_fact");
    expect(first).toMatchObject({
      activity_risk: { rules_version: 1, action: "normal" },
      elimination_trace: [],
    });
    expect(first.invariant_trace).toHaveLength(1);

    const answeredRaw = parseResult(await client.callTool({
      name: "foundation_answer_question",
      arguments: { analysis_id: first.analysis_id, answer: "No. Work must continue during an outage." },
    }));
    const answered = DecisionResultSchema.parse(answeredRaw);
    expect(answered.interaction_mode).toBe("decide");
    if (answered.interaction_mode !== "decide") throw new Error("Expected a selected decide result");
    expect(answered.recommendation).toContain("offline_first");

    const committed = parseResult(await client.callTool({
      name: "foundation_commit",
      arguments: {
        project_root: root,
        analysis_id: first.analysis_id,
        included_capabilities: ["offline continuity"],
        evidence_checks: [{ id: "safe-evidence", command: "npm", args: ["run", "evidence"] }],
      },
    })) as { revision: number; foundation: Record<string, unknown> };
    expect(committed.revision).toBe(1);
    expect(committed.foundation.schema_version).toBe(FOUNDATION_SCHEMA_VERSION);
    expect(Object.keys(committed.foundation).sort()).toEqual([...FOUNDATION_V1_KEYS].sort());

    const foundationJson = parseResult(await client.callTool({
      name: "foundation_get",
      arguments: { project_root: root, format: "json" },
    })) as Record<string, unknown>;
    expect(foundationJson.schema_version).toBe(1);
    expect(Object.keys(foundationJson).sort()).toEqual([...FOUNDATION_V1_KEYS].sort());
    expect(foundationJson).toEqual(committed.foundation);
    expect(JSON.parse(await readFile(
      path.join(root, ".project-foundation", "foundation.json"),
      "utf8",
    ))).toEqual(foundationJson);

    const markdown = parseResult(await client.callTool({
      name: "foundation_get",
      arguments: { project_root: root, format: "markdown" },
    })) as string;
    expect(markdown).toContain("# Project Foundation");
    const brief = parseResult(await client.callTool({
      name: "foundation_get",
      arguments: { project_root: root, format: "session-brief" },
    })) as string;
    expect(brief).toContain("Foundation Session Brief");

    await writeFile(path.join(root, "billing.ts"), "import Stripe from 'stripe';\nconst checkout = stripe.checkout.sessions.create({});\n");
    const scan = parseResult(await client.callTool({
      name: "foundation_scan_changes",
      arguments: { project_root: root },
    })) as {
      release_review_questions: readonly string[];
      findings: Record<string, { confidence: string; evidence: readonly Record<string, unknown>[] }>;
    };
    expect(scan.release_review_questions).toHaveLength(5);
    expect(scan.findings.payment?.confidence).toBe("high");
    expect(scan.findings.payment?.evidence).toContainEqual(expect.objectContaining({
      source: "git_diff",
      marker: "payment-provider-integration",
    }));

    const preview = parseResult(await client.callTool({
      name: "foundation_verify",
      arguments: { project_root: root, check_id: "safe-evidence", mode: "preview" },
    })) as { executable: string };
    expect(preview.executable).toBe("npm");
    const run = parseResult(await client.callTool({
      name: "foundation_verify",
      arguments: { project_root: root, check_id: "safe-evidence", mode: "run" },
    })) as { record: { status: string; output: string } };
    expect(run.record.status).toBe("passed");
    expect(run.record.output).toContain("evidence passed");

    expect(await readFile(path.join(root, ".project-foundation", "foundation.json"), "utf8")).toContain("offline_first");
    expect(await readFile(path.join(root, ".project-foundation", "evidence.json"), "utf8")).toContain("safe-evidence");
    await client.close();
    await server.close();
  });

  it("serializes every existing non-abstain result plus additive traces and abstain", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "foundation-mcp-result-compatibility-"));
    process.env.FOUNDATION_ALLOWED_ROOTS = root;

    const decideAnalysis = analysis([route("managed_decide")]);
    const confirmAnalysis = analysis([route("managed_confirm")], { facts: [fact()] });
    const deadline = consequenceRoute("deadline_route", "launch", "the fixed date is protected", {
      scores: {
        delivery_speed: 95, user_value: 70, reliability: 60, cost_efficiency: 90,
        operational_simplicity: 90, reversibility: 50, future_fit: 65,
      },
      tradeoff: durableTradeoff(),
    });
    const continuity = consequenceRoute("continuity_route", "outage", "work continues through outages", {
      scores: {
        delivery_speed: 55, user_value: 95, reliability: 95, cost_efficiency: 55,
        operational_simplicity: 45, reversibility: 70, future_fit: 95,
      },
      tradeoff: durableTradeoff(),
    });
    const offerAnalysis = analysis([deadline, continuity], { recommended_route_id: deadline.id });
    const escalateAnalysis = analysis([route("managed_escalate")], {
      risk_state: {
        level: "critical",
        domains: [{
          domain: "medical",
          severity: "critical",
          requires_escalation: true,
          reason: "Qualified clinical review is required.",
        }],
        reasons: ["Qualified clinical review is required."],
      },
    });
    const incomplete = route("incomplete_sensitive", { satisfied_invariant_ids: [] });
    const abstainAnalysis = analysis([incomplete]);

    const model = new SequenceModel([
      decideAnalysis,
      confirmAnalysis,
      offerAnalysis,
      escalateAnalysis,
      abstainAnalysis,
    ]);
    const service = new FoundationAnalysisService({ modelClient: model });
    const server = createFoundationMcpServer({ modelClient: model, analysisService: service });
    const client = new Client({ name: "result-compatibility", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const requests = [
      "Build an ordinary scheduling application.",
      "Build a field application; outage continuity is not yet known.",
      "The launch deadline conflicts with outage continuity.",
      "Build a system that makes clinical treatment recommendations.",
      "Build a normal account system, but the supplied route omits required safeguards.",
    ];
    const results = [];
    for (const requirement of requests) {
      const raw = parseResult(await client.callTool({
        name: "foundation_analyze_project",
        arguments: { project_root: root, requirement },
      }));
      results.push(DecisionResultSchema.parse(raw));
    }

    expect(results.map((result) => result.interaction_mode)).toEqual([
      "decide",
      "confirm_fact",
      "offer_two_routes",
      "escalate",
      "abstain",
    ]);
    for (const result of results) {
      expect(result.activity_risk.rules_version).toBe(1);
      expect(Array.isArray(result.invariant_trace)).toBe(true);
      expect(Array.isArray(result.elimination_trace)).toBe(true);
    }

    const decide = results[0];
    expect(decide?.interaction_mode).toBe("decide");
    if (decide?.interaction_mode !== "decide") throw new Error("Expected decide compatibility result");
    expect(typeof decide.recommendation).toBe("string");
    expect(typeof decide.major_drawback).toBe("string");
    expect(typeof decide.key_assumption).toBe("string");
    expect(typeof decide.change_condition).toBe("string");
    expect(decide.proposed_stack).toBeTruthy();
    expect(decide.architecture).toBeTruthy();
    const confirm = results[1];
    expect(confirm?.interaction_mode).toBe("confirm_fact");
    if (confirm?.interaction_mode !== "confirm_fact") throw new Error("Expected confirm compatibility result");
    expect(typeof confirm.question).toBe("string");
    expect(confirm.question_key).toBe("operations.offline_continuity");
    const offered = results[2];
    expect(offered?.interaction_mode).toBe("offer_two_routes");
    if (offered?.interaction_mode !== "offer_two_routes") throw new Error("Expected offer compatibility result");
    expect(offered.routes).toHaveLength(2);
    const escalated = results[3];
    expect(escalated?.interaction_mode).toBe("escalate");
    if (escalated?.interaction_mode !== "escalate") throw new Error("Expected escalation compatibility result");
    expect(escalated.escalation_reason).toContain("medical");
    const abstained = results[4];
    expect(abstained?.interaction_mode).toBe("abstain");
    if (abstained?.interaction_mode !== "abstain") throw new Error("Expected abstain compatibility result");
    expect(abstained.abstention_reason).toBe("no_feasible_route");
    expect(typeof abstained.abstention_detail).toBe("string");
    expect(Array.isArray(abstained.recovery.missing_evidence)).toBe(true);
    expect(abstained.elimination_trace).toContainEqual(expect.objectContaining({
      route_id: "incomplete_sensitive",
      reason: "missing_invariant",
    }));
    expect(abstained).not.toHaveProperty("recommendation");

    await client.close();
    await server.close();
  });

  it("parses and reserializes a direct legacy non-abstain payload without trace fields", () => {
    const legacyPayload = JSON.parse(LEGACY_V01_DECIDE_JSON) as Record<string, unknown>;
    expect(legacyPayload).not.toHaveProperty("activity_risk");
    expect(legacyPayload).not.toHaveProperty("elimination_trace");
    expect(legacyPayload).not.toHaveProperty("invariant_trace");
    expect(Object.keys(legacyPayload).sort()).toEqual([
      "analysis_id",
      "architecture",
      "change_condition",
      "facts",
      "interaction_mode",
      "key_assumption",
      "major_drawback",
      "proposed_stack",
      "recommendation",
      "risk_state",
    ]);

    const parsed = DecisionResultSchema.parse(legacyPayload);
    expect(parsed.interaction_mode).toBe("decide");
    if (parsed.interaction_mode !== "decide") throw new Error("Expected legacy decide payload");
    expect(parsed.recommendation).toBe(legacyPayload.recommendation);
    expect(parsed.activity_risk).toEqual({
      rules_version: 1,
      primary_activity: null,
      action: "normal",
      scope_question_key: null,
      matched_rule_ids: [],
      evidence: [],
    });
    expect(parsed.elimination_trace).toEqual([]);
    expect(parsed.invariant_trace).toEqual([]);

    const reserialized = JSON.parse(JSON.stringify(parsed)) as unknown;
    expect(() => DecisionResultSchema.parse(reserialized)).not.toThrow();
    expect(reserialized).toMatchObject(legacyPayload);
  });

  it("rejects cross-project and stale reassessment commits while preserving unaffected state", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "foundation-mcp-binding-"));
    const { mkdir } = await import("node:fs/promises");
    const projectA = path.join(parent, "a");
    const projectB = path.join(parent, "b");
    await Promise.all([mkdir(projectA), mkdir(projectB)]);
    process.env.FOUNDATION_ALLOWED_ROOTS = parent;
    const model = new InventoryModel();
    const service = new FoundationAnalysisService({ modelClient: model });
    const server = createFoundationMcpServer({ modelClient: model, analysisService: service });
    const client = new Client({ name: "binding-integration", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const analyzed = parseResult(await client.callTool({
      name: "foundation_analyze_project",
      arguments: { project_root: projectA, requirement: "Build a normal Web app." },
    })) as { analysis_id: string };
    const cross = await client.callTool({
      name: "foundation_commit",
      arguments: { project_root: projectB, analysis_id: analyzed.analysis_id },
    });
    expect(cross.isError).toBe(true);

    await client.callTool({
      name: "foundation_answer_question",
      arguments: { analysis_id: analyzed.analysis_id, answer: "Work may pause during outages." },
    });

    await client.callTool({
      name: "foundation_commit",
      arguments: {
        project_root: projectA,
        analysis_id: analyzed.analysis_id,
        included_capabilities: ["existing accounts"],
        excluded_capabilities: ["real payments"],
      },
    });
    const reassessed = parseResult(await client.callTool({
      name: "foundation_assess_change",
      arguments: { project_root: projectA, new_requirement: "Now add sensitive health data." },
    })) as { analysis_id: string };

    // Mutate the base Foundation after analysis, making the reassessment stale.
    const secondAnalysis = parseResult(await client.callTool({
      name: "foundation_analyze_project",
      arguments: { project_root: projectA, requirement: "Refresh the general foundation." },
    })) as { analysis_id: string };
    await client.callTool({
      name: "foundation_answer_question",
      arguments: { analysis_id: secondAnalysis.analysis_id, answer: "Work may pause during outages." },
    });
    await client.callTool({
      name: "foundation_commit",
      arguments: { project_root: projectA, analysis_id: secondAnalysis.analysis_id },
    });
    const stale = await client.callTool({
      name: "foundation_commit",
      arguments: { project_root: projectA, analysis_id: reassessed.analysis_id },
    });
    expect(stale.isError).toBe(true);
    await client.close();
    await server.close();
  });
});
