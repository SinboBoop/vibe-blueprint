#!/usr/bin/env node
import { readFileSync } from "node:fs";
import process from "node:process";
import { parseDocument } from "yaml";

const skillPath = "skill/vibe-blueprint/SKILL.md";
const agentPath = "skill/vibe-blueprint/agents/openai.yaml";
const evalPath = "skill/vibe-blueprint/evals/evals.json";
const skill = readFileSync(skillPath, "utf8");
const agentSource = readFileSync(agentPath, "utf8");
const evals = JSON.parse(readFileSync(evalPath, "utf8"));

const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/u)?.[1];
if (frontmatter === undefined) throw new Error("SKILL.md has no valid frontmatter");
const frontmatterLines = frontmatter.split("\n").filter((line) => line.trim().length > 0);
if (
  frontmatterLines.length !== 2 ||
  frontmatterLines[0] !== "name: vibe-blueprint" ||
  !frontmatterLines[1]?.startsWith("description: ")
) {
  throw new Error("SKILL.md frontmatter must contain only the approved name and description");
}
const description = frontmatterLines[1].slice("description: ".length).trim();
if (description.length === 0 || description.length > 1024 || /[<>]/u.test(description)) {
  throw new Error("SKILL.md description is empty or invalid");
}
if (skill.split("\n").length > 500) throw new Error("SKILL.md exceeds the thin-Skill limit");

for (const required of [
  "foundation_doctor",
  "foundation_analyze_project",
  "foundation_assess_change",
  "foundation_answer_question",
  "foundation_commit",
  "foundation_scan_changes",
  "foundation_verify",
  "`decide`",
  "`confirm_fact`",
  "`offer_two_routes`",
  "`escalate`",
  "`abstain`",
]) {
  if (!skill.includes(required)) throw new Error(`SKILL.md is missing ${required}`);
}

const agentDocument = parseDocument(agentSource, { uniqueKeys: true });
if (agentDocument.errors.length > 0) {
  throw new Error(`agents/openai.yaml is invalid: ${agentDocument.errors[0]?.message}`);
}
const agent = agentDocument.toJS({ maxAliasCount: 0 });
if (agent?.interface?.display_name !== "Vibe Blueprint") {
  throw new Error("agents/openai.yaml has the wrong display name");
}
if (
  typeof agent?.interface?.default_prompt !== "string" ||
  !agent.interface.default_prompt.includes("$vibe-blueprint")
) {
  throw new Error("agents/openai.yaml default prompt must mention $vibe-blueprint");
}
const tools = agent?.dependencies?.tools;
if (
  !Array.isArray(tools) ||
  tools.length !== 1 ||
  tools[0]?.type !== "mcp" ||
  tools[0]?.value !== "vibe_blueprint" ||
  tools[0]?.transport !== "stdio"
) {
  throw new Error("agents/openai.yaml has the wrong MCP registration key");
}

if (evals?.skill_name !== "vibe-blueprint") throw new Error("Eval Skill identity is wrong");
if (!Array.isArray(evals.evals) || evals.evals.length !== 10) {
  throw new Error("Expected exactly 10 output eval cases");
}
if (!Array.isArray(evals.trigger_evals) || evals.trigger_evals.length !== 12) {
  throw new Error("Expected exactly 12 trigger eval cases");
}
if (
  evals.evals.some((item) =>
    !Number.isSafeInteger(item?.id) ||
    typeof item.prompt !== "string" || item.prompt.length === 0 ||
    typeof item.expected_output !== "string" || item.expected_output.length === 0 ||
    !Array.isArray(item.expectations) || item.expectations.length === 0,
  )
) throw new Error("An output eval case is incomplete");
if (
  !evals.trigger_evals.some((item) => item?.should_trigger === true) ||
  !evals.trigger_evals.some((item) => item?.should_trigger === false)
) throw new Error("Trigger evals must include positive and negative cases");

process.stdout.write("Vibe Blueprint Skill validation passed (10 output evals; 12 trigger evals).\n");
