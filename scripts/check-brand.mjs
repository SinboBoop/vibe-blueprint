#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
).trim().split("\n").filter(Boolean).filter((file) =>
  existsSync(file) &&
  !file.startsWith("node_modules/") &&
  !file.startsWith("dist/") &&
  file !== "scripts/check-brand.mjs",
);

const legacyPattern = /Foundation Guard|foundation-guard(?:-mcp)?|Plan Project Foundation|plan-project-foundation|foundation_guard/gu;
const exactAllowedLines = new Map([
  [".gitignore", new Set([".foundation-guard-credentials"])],
  ["package.json", new Set([
    '    "foundation-guard-mcp": "dist/server.js",',
    '    "foundation-guard": "dist/cli.js"',
  ])],
  ["package-lock.json", new Set([
    '        "foundation-guard": "dist/cli.js",',
    '        "foundation-guard-mcp": "dist/server.js",',
  ])],
  ["schemas/foundation.schema.json", new Set([
    '  "$id": "https://foundation-guard.dev/schemas/foundation.schema.json",',
  ])],
  ["src/config.ts", new Set([
    'const LEGACY_CONFIG_DIRECTORY_NAME = "foundation-guard";',
  ])],
  ["README.md", new Set([
    "Before the public rename, local checkouts used the pre-release executable aliases `foundation-guard` and `foundation-guard-mcp` and stored credentials under a `foundation-guard` user-config directory. This package temporarily keeps those executable aliases and safely reads that credential location when the new one is absent, so existing local users do not need to re-enter a key. New setup should use `vibe-blueprint`, `vibe-blueprint-mcp`, the `vibe_blueprint` client key, and the `skill/vibe-blueprint` path.",
  ])],
  ["docs/client-configs.md", new Set([
    "New installations should use the `vibe_blueprint` client key and `vibe-blueprint-mcp` executable shown above. Existing local registrations that still point to the temporary `foundation-guard-mcp` compatibility alias continue to start the same server; remove the old registration and add the new one when convenient. Do not register both names at once, because that would expose the same eight tools twice.",
  ])],
  ["docs/security.md", new Set([
    "For users of the pre-release name, reads also check the former `foundation-guard/credentials.json` user-config location only when the new credential is absent. The fallback is local and read-only during discovery: it does not print, copy into the repository, or silently expose the key. A new credential takes precedence, and `auth status` reports the source without revealing the value. `FOUNDATION_CONFIG_DIR` remains the explicit override contract and is not combined with default-path fallback.",
  ])],
  ["scripts/check-package.mjs", new Set([
    '  "docs/assets/foundation-guard-hero.html",',
    '  "docs/assets/foundation-guard-hero.png",',
  ])],
  ["tests/e2e/stdio.e2e.test.ts", new Set([
    '  "foundation-guard": "dist/cli.js",',
    '  "foundation-guard-mcp": "dist/server.js",',
    '    for (const name of ["vibe-blueprint", "foundation-guard"] as const) {',
    '    for (const name of ["vibe-blueprint-mcp", "foundation-guard-mcp"] as const) {',
    '    const legacyDirectory = path.join(xdgConfigHome, "foundation-guard");',
    '    const deleted = await execFileAsync(installedBins["foundation-guard"], ["auth", "delete"], {',
    '      expect(help.stdout).not.toContain("foundation-guard auth");',
  ])],
  ["tests/unit/config.test.ts", new Set([
    '      path.join(homeDir, ".config", "foundation-guard", "credentials.json"),',
  ])],
  ["tests/unit/security-state.test.ts", new Set([
    '  const directory = await mkdtemp(path.join(os.tmpdir(), "foundation-guard-test-"));',
    '    const legacyPath = path.join(homeDir, ".config", "foundation-guard", "credentials.json");',
    '    const legacyPath = path.join(xdgConfigHome, "foundation-guard", "credentials.json");',
  ])],
]);

const findings = [];
const observed = new Map();
for (const file of files) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    legacyPattern.lastIndex = 0;
    if (!legacyPattern.test(line)) continue;
    const allowed = exactAllowedLines.get(file);
    if (allowed?.has(line) === true) {
      const key = `${file}\0${line}`;
      observed.set(key, (observed.get(key) ?? 0) + 1);
    } else {
      findings.push(`${file}:${index + 1}:${line.trim()}`);
    }
  }
}

for (const [file, lines] of exactAllowedLines) {
  for (const line of lines) {
    if ((observed.get(`${file}\0${line}`) ?? 0) === 0) {
      findings.push(`${file}:allowlist entry is stale or missing: ${line}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`Legacy-brand check failed at ${findings.length} location(s):\n${findings.map((finding) => `- ${finding}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`Legacy-brand check passed (${files.length} files; exact compatibility lines only).\n`);
