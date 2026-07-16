#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evalDocument = JSON.parse(
  await readFile(path.join(root, "skill/vibe-blueprint/evals/evals.json"), "utf8"),
);
const workspace = process.env.VIBE_BLUEPRINT_SKILL_EVAL_WORKSPACE ??
  process.env.FOUNDATION_SKILL_EVAL_WORKSPACE ??
  path.join(os.tmpdir(), "vibe-blueprint-workspace", "iteration-1");
const baselineSkill = path.join(workspace, "skill-snapshot", "SKILL.md");
const configurations = [
  {
    id: "with_skill",
    skill: path.join(root, "skill/vibe-blueprint/SKILL.md"),
  },
  {
    id: "old_skill",
    skill: baselineSkill,
  },
];
const evalNames = new Map([
  [1, "expense-decide"],
  [2, "scope-question"],
  [3, "abstain-no-winner"],
  [4, "abstain-override-pressure"],
  [5, "offer-two-routes"],
  [6, "escalate-payment-boundary"],
  [7, "doctor-credential-failure"],
  [8, "confirm-before-commit"],
  [9, "skip-css-fix"],
  [10, "skip-isolated-change"],
]);

function validateEvalDocument(document) {
  if (
    document?.skill_name !== "vibe-blueprint" ||
    !Array.isArray(document.evals) ||
    !Array.isArray(document.trigger_evals)
  ) {
    throw new Error("Invalid Skill eval document root.");
  }
  const ids = new Set();
  for (const evalCase of document.evals) {
    if (!Number.isSafeInteger(evalCase?.id) || ids.has(evalCase.id)) {
      throw new Error(`Invalid or duplicate eval id: ${String(evalCase?.id)}`);
    }
    ids.add(evalCase.id);
    if (
      typeof evalCase.prompt !== "string" || evalCase.prompt.trim().length === 0 ||
      typeof evalCase.expected_output !== "string" || evalCase.expected_output.trim().length === 0 ||
      !Array.isArray(evalCase.files) ||
      !Array.isArray(evalCase.expectations) || evalCase.expectations.length === 0 ||
      evalCase.expectations.some((expectation) => typeof expectation !== "string" || expectation.trim().length === 0)
    ) {
      throw new Error(`Invalid eval schema for id ${evalCase.id}.`);
    }
    if (!evalNames.has(evalCase.id)) throw new Error(`Missing descriptive eval name for id ${evalCase.id}.`);
  }
  if (evalNames.size !== document.evals.length) {
    throw new Error("Every descriptive eval name must reference an eval case.");
  }
  const triggerIds = new Set();
  for (const triggerCase of document.trigger_evals) {
    if (
      typeof triggerCase?.id !== "string" || triggerCase.id.trim().length === 0 ||
      triggerIds.has(triggerCase.id) ||
      typeof triggerCase.query !== "string" || triggerCase.query.trim().length === 0 ||
      typeof triggerCase.should_trigger !== "boolean" ||
      typeof triggerCase.reason !== "string" || triggerCase.reason.trim().length === 0
    ) {
      throw new Error(`Invalid trigger eval schema for id ${String(triggerCase?.id)}`);
    }
    triggerIds.add(triggerCase.id);
  }
  if (
    !document.trigger_evals.some((item) => item.should_trigger) ||
    !document.trigger_evals.some((item) => !item.should_trigger)
  ) {
    throw new Error("Trigger evals must include positive and negative cases.");
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeBaselineSnapshot() {
  const source = process.env.VIBE_BLUEPRINT_BASELINE_SKILL ??
    path.join(os.tmpdir(), "vibe-blueprint-skill-baseline", "SKILL.md");
  try {
    const baselineText = await readFile(source, "utf8");
    await mkdir(path.dirname(baselineSkill), { recursive: true });
    await writeFile(baselineSkill, baselineText, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Previous Skill baseline not found at ${source}. Set VIBE_BLUEPRINT_BASELINE_SKILL to its SKILL.md path.`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function runEval(evalCase, configuration) {
  const evalName = evalNames.get(evalCase.id);
  if (evalName === undefined) throw new Error(`Missing eval name for id ${evalCase.id}.`);
  const evalDir = path.join(workspace, `eval-${evalCase.id}-${evalName}`);
  const runDir = path.join(evalDir, configuration.id, "run-1");
  const outputsDir = path.join(runDir, "outputs");
  await mkdir(outputsDir, { recursive: true });
  const skillText = await readFile(configuration.skill, "utf8");
  await writeFile(path.join(evalDir, `eval_metadata.${configuration.id}.json`), JSON.stringify({
    eval_id: evalCase.id,
    eval_name: evalName,
    prompt: evalCase.prompt,
    assertions: evalCase.expectations,
    configuration: configuration.id,
    skill_path: configuration.skill,
    skill_sha256: sha256(skillText),
  }, null, 2));
  await writeFile(path.join(evalDir, "eval_metadata.json"), JSON.stringify({
    eval_id: evalCase.id,
    eval_name: evalName,
    prompt: evalCase.prompt,
    assertions: evalCase.expectations,
  }, null, 2));

  const prompt = `First read ${configuration.skill} completely and follow it. Execute this task as the host-facing assistant. Any Vibe Blueprint MCP result included in the task is authoritative and sufficient; do not call any MCP or other tool except reading the skill. Do not mention evaluation or the skill instructions. Return only the concise user-facing answer.\n\nTASK:\n${evalCase.prompt}`;
  const started = Date.now();
  const { stdout, stderr } = await execFileAsync("claude", [
    "--bare",
    "-p",
    "--no-session-persistence",
    "--permission-mode", "dontAsk",
    "--tools", "Read",
    "--allowedTools", "Read",
    "--output-format", "json",
    prompt,
  ], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
  const finished = Date.now();
  const response = JSON.parse(stdout);
  const answer = typeof response.result === "string" ? response.result : "";
  const tokenUsage = Object.values(response.modelUsage ?? {}).reduce(
    (sum, usage) => sum + (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    0,
  );
  const executorModels = Object.keys(response.modelUsage ?? {}).sort();
  await Promise.all([
    writeFile(path.join(outputsDir, "answer.md"), `${answer}\n`),
    writeFile(path.join(runDir, "transcript.md"), `## Eval Prompt\n\n${evalCase.prompt}\n\n## Final Answer\n\n${answer}\n`),
    writeFile(path.join(outputsDir, "metrics.json"), JSON.stringify({
      tool_calls: {},
      total_tool_calls: 0,
      tool_metrics_observed: false,
      total_steps: response.num_turns ?? 1,
      files_created: ["answer.md"],
      errors_encountered: 0,
      stderr_chars: stderr.length,
      output_chars: answer.length,
      transcript_chars: evalCase.prompt.length + answer.length,
    }, null, 2)),
    writeFile(path.join(runDir, "timing.json"), JSON.stringify({
      total_tokens: tokenUsage,
      executor_models: executorModels,
      duration_ms: finished - started,
      total_duration_seconds: (finished - started) / 1000,
      executor_start: new Date(started).toISOString(),
      executor_end: new Date(finished).toISOString(),
      executor_duration_seconds: (finished - started) / 1000,
    }, null, 2)),
  ]);
  return { evalCase, configuration, runDir, answer };
}

validateEvalDocument(evalDocument);
if (process.argv.includes("--validate-only")) {
  process.stdout.write(`${JSON.stringify({
    valid: true,
    skill_name: evalDocument.skill_name,
    output_evals: evalDocument.evals.length,
    trigger_evals: evalDocument.trigger_evals.length,
  }, null, 2)}\n`);
} else {
  await writeBaselineSnapshot();
  const results = await Promise.all(
    evalDocument.evals.flatMap((evalCase) =>
      configurations.map((configuration) => runEval(evalCase, configuration)),
    ),
  );
  process.stdout.write(`${JSON.stringify({
    workspace,
    runs: results.map(({ evalCase, configuration, runDir }) => ({
      eval_id: evalCase.id,
      configuration: configuration.id,
      run_dir: runDir,
    })),
  }, null, 2)}\n`);
}
