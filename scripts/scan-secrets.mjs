#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
}).trim().split("\n").filter(Boolean).filter((file) =>
  existsSync(file) &&
  !file.startsWith("node_modules/") &&
  !file.startsWith("dist/") &&
  file !== "package-lock.json",
);
const patterns = [
  { label: "sk token", expression: /\b(sk-[A-Za-z0-9_-]{12,})\b/gu },
  { label: "bearer token", expression: /\bBearer\s+([A-Za-z0-9._~+/-]{12,})\b/giu },
  {
    label: "quoted credential assignment",
    expression: /\b(?:FOUNDATION_LLM_API_KEY|api[_-]?key|_authToken|auth[_-]?token|access[_-]?token|client[_-]?secret|secret[_-]?access[_-]?key)["']?\s*[:=]\s*["']([A-Za-z0-9._~+/:=-]{12,})["']/giu,
  },
  {
    label: "environment credential assignment",
    expression: /^\s*(?:export\s+)?FOUNDATION_LLM_API_KEY=([A-Za-z0-9._~+/:=-]{12,})\s*$/gimu,
  },
  {
    label: "unquoted credential assignment",
    expression: /\b(?:api[_-]?key|_authToken|auth[_-]?token|access[_-]?token|client[_-]?secret|secret[_-]?access[_-]?key)=([A-Za-z0-9._~+/:=-]{12,})(?=\s*(?:$|[,;}]))/gimu,
  },
];

const explicitSyntheticFixtures = new Set([
  ["replace", "with", "your", "own", "key"].join("-"),
  ["test", "key", "placeholder"].join("-"),
  ["unit", "placeholder", "key"].join("-"),
  ["environment", "key"].join("-"),
  ["fixture", "token"].join("-"),
  ["offline", "regression", "placeholder"].join("-"),
  ["provider", "token", "without", "standard", "prefix"].join("-"),
  ["sk", "request", "secret"].join("-"),
  ["sk", "answer", "secret"].join("-"),
  ["sk", "provider", "echoed", "secret"].join("-"),
  ["sk", "exampleToken123"].join("-"),
  ["sk", "hiddenValue123"].join("-"),
  ["sk", "secretvalue"].join("-"),
  ["example", "token", "value"].join("-"),
  "another.token_value",
  ["secret", "token", "value"].join("-"),
  ["hidden", "value"].join("-"),
  "plainsecret",
  `npm_${"abcdefghijklmnopqrstuvwxyz"}123456`,
]);

function isExplicitSyntheticFixture(value) {
  return explicitSyntheticFixtures.has(value);
}

const findings = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const pattern of patterns) {
    pattern.expression.lastIndex = 0;
    for (const match of text.matchAll(pattern.expression)) {
      const candidate = match[1];
      if (candidate !== undefined && !isExplicitSyntheticFixture(candidate)) {
        findings.push(`${file}:${pattern.label}`);
      }
    }
  }
}
if (findings.length > 0) {
  process.stderr.write(`Possible credential material found at ${findings.length} location(s).\n`);
  process.exit(1);
}
process.stdout.write(`Secret scan passed (${files.length} files; synthetic redaction fixtures allowlisted).\n`);
