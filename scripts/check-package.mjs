#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";

const packed = spawnSync(
  "npm",
  ["pack", "--json", "--ignore-scripts", "--dry-run"],
  {
    encoding: "utf8",
    env: { ...process.env, npm_config_loglevel: "silent" },
  },
);

if (packed.status !== 0) {
  process.stderr.write(packed.stderr || "npm pack dry run failed\n");
  process.exit(packed.status ?? 1);
}

let report;
try {
  report = JSON.parse(packed.stdout);
} catch {
  process.stderr.write("npm pack did not return valid JSON\n");
  process.exit(1);
}

const artifact = Array.isArray(report) ? report[0] : undefined;
if (artifact === undefined || !Array.isArray(artifact.files)) {
  process.stderr.write("npm pack returned no file inventory\n");
  process.exit(1);
}

const paths = new Set(artifact.files.map((file) => file.path));
const required = [
  ".env.example",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "dist/cli.js",
  "dist/server.js",
  "docs/assets/vibe-blueprint-hero.png",
  "docs/client-configs.md",
  "docs/releases/decision-integrity.md",
  "docs/security.md",
  "package.json",
  "resources/activity-risk-rules.json",
  "resources/architecture-patterns.json",
  "schemas/foundation.schema.json",
  "scripts/scan-secrets.mjs",
  "skill/vibe-blueprint/SKILL.md",
  "skill/vibe-blueprint/agents/openai.yaml",
  "skill/vibe-blueprint/evals/evals.json",
];

const forbiddenPrefixes = [
  "docs/brand-candidates/",
  "docs/brand-review-round-2/",
  "docs/roadmaps/",
  "openspec/",
  "src/",
  "tests/",
];
const forbiddenExact = new Set([
  "docs/assets/foundation-guard-hero.html",
  "docs/assets/foundation-guard-hero.png",
  "docs/releases/live-provider-verification.json",
]);
const forbiddenPatterns = [
  /(?:^|\/)feedback\.json$/u,
  /(?:^|\/)timing\.json$/u,
  /(?:^|\/)transcript(?:\.|\/)/u,
  /(?:^|\/)benchmark-workspace(?:\/|$)/u,
  /^scripts\/(?!scan-secrets\.mjs$)/u,
];

const missing = required.filter((file) => !paths.has(file));
const forbidden = [...paths].filter((file) =>
  forbiddenExact.has(file) ||
  forbiddenPrefixes.some((prefix) => file.startsWith(prefix)) ||
  forbiddenPatterns.some((pattern) => pattern.test(file)),
);

if (missing.length > 0 || forbidden.length > 0) {
  if (missing.length > 0) {
    process.stderr.write(`Missing required package files:\n${missing.map((file) => `- ${file}`).join("\n")}\n`);
  }
  if (forbidden.length > 0) {
    process.stderr.write(`Forbidden package files:\n${forbidden.map((file) => `- ${file}`).join("\n")}\n`);
  }
  process.exit(1);
}

process.stdout.write(`Package content check passed (${paths.size} files).\n`);
