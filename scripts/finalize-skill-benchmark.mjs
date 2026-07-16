#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const workspace = process.env.VIBE_BLUEPRINT_SKILL_EVAL_WORKSPACE ??
  process.env.FOUNDATION_SKILL_EVAL_WORKSPACE ??
  path.join(os.tmpdir(), "vibe-blueprint-workspace", "iteration-1");
const benchmarkPath = path.join(workspace, "benchmark.json");
const benchmark = JSON.parse(await readFile(benchmarkPath, "utf8"));
const configurationOrder = ["with_skill", "old_skill"];
const configurationMetadata = {};
const executorModels = new Set();

function stats(values) {
  if (values.length === 0) return { mean: 0, stddev: 0, min: 0, max: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length === 1
    ? 0
    : values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1);
  return {
    mean: Number(mean.toFixed(4)),
    stddev: Number(Math.sqrt(variance).toFixed(4)),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

for (const run of benchmark.runs) {
  const evalDirectory = (await import("node:fs/promises")).readdir(workspace).then((names) =>
    names.find((name) => name.startsWith(`eval-${run.eval_id}-`)));
  const evalName = await evalDirectory;
  if (evalName === undefined) throw new Error(`Missing eval directory for ${run.eval_id}`);
  const timing = JSON.parse(await readFile(path.join(
    workspace,
    evalName,
    run.configuration,
    `run-${run.run_number}`,
    "timing.json",
  ), "utf8"));
  run.result.tokens = timing.total_tokens;
  run.result.time_seconds = timing.total_duration_seconds;
  for (const model of timing.executor_models ?? []) executorModels.add(model);
  const configuration = JSON.parse(await readFile(path.join(
    workspace,
    evalName,
    `eval_metadata.${run.configuration}.json`,
  ), "utf8"));
  const current = configurationMetadata[run.configuration];
  if (current !== undefined && current.skill_sha256 !== configuration.skill_sha256) {
    throw new Error(`Configuration ${run.configuration} changed between evals.`);
  }
  configurationMetadata[run.configuration] = {
    skill_path: configuration.skill_path,
    skill_sha256: configuration.skill_sha256,
  };
}

benchmark.runs.sort((left, right) =>
  left.eval_id - right.eval_id ||
  configurationOrder.indexOf(left.configuration) - configurationOrder.indexOf(right.configuration) ||
  left.run_number - right.run_number,
);

const summary = {};
for (const configuration of configurationOrder) {
  const runs = benchmark.runs.filter((run) => run.configuration === configuration);
  summary[configuration] = {
    pass_rate: stats(runs.map((run) => run.result.pass_rate)),
    time_seconds: stats(runs.map((run) => run.result.time_seconds)),
    tokens: stats(runs.map((run) => run.result.tokens)),
  };
}
summary.delta = {
  pass_rate: `${summary.with_skill.pass_rate.mean - summary.old_skill.pass_rate.mean >= 0 ? "+" : ""}${(summary.with_skill.pass_rate.mean - summary.old_skill.pass_rate.mean).toFixed(2)}`,
  time_seconds: `${summary.with_skill.time_seconds.mean - summary.old_skill.time_seconds.mean >= 0 ? "+" : ""}${(summary.with_skill.time_seconds.mean - summary.old_skill.time_seconds.mean).toFixed(1)}`,
  tokens: `${summary.with_skill.tokens.mean - summary.old_skill.tokens.mean >= 0 ? "+" : ""}${(summary.with_skill.tokens.mean - summary.old_skill.tokens.mean).toFixed(0)}`,
};

benchmark.metadata.skill_name = "vibe-blueprint";
benchmark.metadata.skill_path = "skill/vibe-blueprint/SKILL.md";
benchmark.metadata.executor_model = executorModels.size === 0
  ? "Claude Code CLI (model not reported)"
  : [...executorModels].join(", ");
benchmark.metadata.analyzer_model = "deterministic rubric plus manual analyst pass";
benchmark.metadata.runs_per_configuration = 1;
benchmark.metadata.configuration_order = configurationOrder;
benchmark.metadata.configurations = configurationMetadata;
benchmark.run_summary = summary;
benchmark.metadata.evals_run = [...new Set(benchmark.runs.map((run) => run.eval_id))].sort((a, b) => a - b);

const micro = {};
for (const configuration of configurationOrder) {
  const runs = benchmark.runs.filter((run) => run.configuration === configuration);
  const passed = runs.reduce((sum, run) => sum + run.result.passed, 0);
  const total = runs.reduce((sum, run) => sum + run.result.total, 0);
  micro[configuration] = { passed, total, pass_rate: total === 0 ? 0 : passed / total };
}
benchmark.assertion_summary = micro;

const bothPass = benchmark.metadata.evals_run.filter((evalId) => {
  const runs = benchmark.runs.filter((run) => run.eval_id === evalId);
  return runs.length === 2 && runs.every((run) => run.result.pass_rate === 1);
});
benchmark.notes = [
  "Each case ran once per configuration. Percentages and deltas below are descriptive functional-check results only; zero standard deviation would not establish repeatability, significance, or superiority.",
  ...(bothPass.length === 0 ? [] : [`Evals ${bothPass.join(", ")} passed in both configurations and therefore do not distinguish Vibe Blueprint from the previous Skill baseline in this run.`]),
  "The checked assertions cover Vibe Blueprint host presentation and scope boundaries only; they do not measure MCP decision accuracy or production readiness.",
];

const markdown = `# Skill Benchmark: Vibe Blueprint

**Model**: ${benchmark.metadata.executor_model}
**Runs**: one per case and configuration

| Metric | Vibe Blueprint | Previous Skill | Delta |
| --- | ---: | ---: | ---: |
| Mean assertion pass rate across cases (descriptive) | ${(summary.with_skill.pass_rate.mean * 100).toFixed(1)}% | ${(summary.old_skill.pass_rate.mean * 100).toFixed(1)}% | ${summary.delta.pass_rate} |
| Assertion pass rate across all checks | ${(micro.with_skill.pass_rate * 100).toFixed(1)}% (${micro.with_skill.passed}/${micro.with_skill.total}) | ${(micro.old_skill.pass_rate * 100).toFixed(1)}% (${micro.old_skill.passed}/${micro.old_skill.total}) | — |
| Mean time per case | ${summary.with_skill.time_seconds.mean.toFixed(1)}s | ${summary.old_skill.time_seconds.mean.toFixed(1)}s | ${summary.delta.time_seconds}s |
| Mean tokens per case | ${summary.with_skill.tokens.mean.toFixed(0)} | ${summary.old_skill.tokens.mean.toFixed(0)} | ${summary.delta.tokens} |

## Interpretation limits

${benchmark.notes.map((note) => `- ${note}`).join("\n")}
`;

await Promise.all([
  writeFile(benchmarkPath, `${JSON.stringify(benchmark, null, 2)}\n`),
  writeFile(path.join(workspace, "benchmark.md"), markdown),
]);
