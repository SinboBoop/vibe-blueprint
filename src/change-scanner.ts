import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import path from "node:path";

import {
  resolveProjectRoot,
  type ResolveProjectRootOptions,
} from "./project-path.js";
import { redactSensitiveText, truncateUtf8 } from "./security.js";

export type FoundationSignal = "payment" | "multitenancy" | "offline" | "sensitive_data";
export type SignalConfidence = "none" | "low" | "medium" | "high";
export type EvidenceStrength = "ambiguous" | "supporting" | "explicit";
export type EvidenceSource = "git_diff" | "dependency" | "migration" | "environment" | "structure";

export interface ChangeEvidence {
  readonly source: EvidenceSource;
  readonly strength: EvidenceStrength;
  readonly signal: FoundationSignal;
  readonly marker: string;
  readonly location?: string;
  readonly explanation: string;
}

export interface SignalFinding {
  readonly signal: FoundationSignal;
  readonly confidence: SignalConfidence;
  readonly requiresReassessment: boolean;
  readonly evidence: readonly ChangeEvidence[];
}

export interface ChangeScanResult {
  readonly projectRoot: string;
  readonly scannedAt: string;
  readonly gitAvailable: boolean;
  readonly diffTruncated: boolean;
  readonly filesInspected: number;
  readonly findings: Readonly<Record<FoundationSignal, SignalFinding>>;
  readonly affectedCapabilities: readonly FoundationSignal[];
  readonly requiresReassessment: boolean;
  readonly warnings: readonly string[];
}

export interface ChangeScanOptions extends ResolveProjectRootOptions {
  readonly diff?: string;
  readonly baseRef?: string;
  readonly maxDiffBytes?: number;
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly now?: () => Date;
}

interface CandidateText {
  readonly source: EvidenceSource;
  readonly location?: string;
  readonly text: string;
}

interface PatternRule {
  readonly signal: FoundationSignal;
  readonly marker: string;
  readonly strength: EvidenceStrength;
  readonly pattern: RegExp;
  readonly explanation: string;
}

const SIGNALS: readonly FoundationSignal[] = [
  "payment",
  "multitenancy",
  "offline",
  "sensitive_data",
];

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "target",
  "vendor",
  ".cache",
]);

const SAFE_ENV_EXAMPLE_NAMES = new Set([".env.example", ".env.sample", ".env.template"]);
const SENSITIVE_BASENAME = /(?:^|[._-])(?:credential|credentials|secret|secrets|private|auth|token|password|passwd)(?:[._-]|$)/iu;
const PRIVATE_KEY_FILE = /\.(?:pem|key|p12|pfx|jks|keystore)$/iu;
const MIGRATION_PATH = /(?:^|\/)(?:migrations?|db\/migrate|prisma\/migrations?)(?:\/|$)/iu;
const SOURCE_LIKE_EXTENSION = /\.(?:[cm]?[jt]sx?|json|ya?ml|toml|sql|prisma|graphql|gql|md|txt|env|properties)$/iu;

const RULES: readonly PatternRule[] = [
  {
    signal: "payment",
    marker: "payment-provider-integration",
    strength: "explicit",
    pattern: /\b(?:stripe|adyen|braintree|paypal|payment_intents?|checkout\.sessions?|squareup)\b/iu,
    explanation: "A dedicated payment provider or payment-processing primitive is present",
  },
  {
    signal: "payment",
    marker: "money-flow",
    strength: "supporting",
    pattern: /\b(?:payments?|billing|subscriptions?|invoices?|checkout|refunds?|charges?)\b/iu,
    explanation: "Payment or billing vocabulary appears in changed project material",
  },
  {
    signal: "payment",
    marker: "ambiguous-price",
    strength: "ambiguous",
    pattern: /\b(?:price|plan|paid|purchase)\b/iu,
    explanation: "A money-adjacent keyword appears without proof of real payment processing",
  },
  {
    signal: "multitenancy",
    marker: "tenant-isolation-primitive",
    strength: "explicit",
    pattern: /\b(?:tenant_id|organization_id|org_id|current_tenant|row[ -]level security|tenant isolation|create policy[^\n]{0,80}(?:tenant|org))\b/iu,
    explanation: "A tenant ownership or isolation primitive is present",
  },
  {
    signal: "multitenancy",
    marker: "organization-model",
    strength: "supporting",
    pattern: /\b(?:multi[ -]?tenant|organizations?|workspaces?|team members?|tenant)\b/iu,
    explanation: "Organization or tenant modeling vocabulary appears",
  },
  {
    signal: "multitenancy",
    marker: "ambiguous-account",
    strength: "ambiguous",
    pattern: /\b(?:account|company|team)\b/iu,
    explanation: "An account-like keyword appears without evidence of tenant isolation",
  },
  {
    signal: "offline",
    marker: "offline-sync-primitive",
    strength: "explicit",
    pattern: /\b(?:serviceworker|service worker|workbox|indexeddb|background sync|sync queue|offline[ -]first|conflict resolution|navigator\.online|navigator\.onLine)\b/iu,
    explanation: "An offline execution, persistence, or synchronization primitive is present",
  },
  {
    signal: "offline",
    marker: "offline-behavior",
    strength: "supporting",
    pattern: /\b(?:offline|disconnected|reconnect|local cache|synchroni[sz]e)\b/iu,
    explanation: "Offline or synchronization behavior is mentioned",
  },
  {
    signal: "offline",
    marker: "ambiguous-cache",
    strength: "ambiguous",
    pattern: /\b(?:cache|local storage|localstorage|retry)\b/iu,
    explanation: "A local caching keyword appears without proof of offline operation",
  },
  {
    signal: "sensitive_data",
    marker: "regulated-sensitive-data",
    strength: "explicit",
    pattern: /\b(?:hipaa|protected health information|medical records?|health records?|social security number|ssn|passport_number|biometric|children'?s data|child data|credit card number|cardholder data|encrypted_pii)\b/iu,
    explanation: "A regulated or intrinsically sensitive data class is present",
  },
  {
    signal: "sensitive_data",
    marker: "personal-data",
    strength: "supporting",
    pattern: /\b(?:pii|personally identifiable|personal data|date of birth|patient|diagnosis|medical|financial data)\b/iu,
    explanation: "Personal or sensitive data vocabulary appears",
  },
  {
    signal: "sensitive_data",
    marker: "ambiguous-private",
    strength: "ambiguous",
    pattern: /\b(?:sensitive|private|user data|profile)\b/iu,
    explanation: "A broad privacy keyword appears without a specific sensitive data class",
  },
];

const EXPLICIT_DEPENDENCIES: Readonly<Record<FoundationSignal, ReadonlySet<string>>> = {
  payment: new Set([
    "stripe",
    "adyen-node-api-library",
    "braintree",
    "paypal-rest-sdk",
    "@paypal/checkout-server-sdk",
    "square",
  ]),
  multitenancy: new Set(["@clerk/backend", "@workos-inc/node"]),
  offline: new Set(["workbox-window", "workbox-core", "dexie", "idb", "pouchdb" ]),
  sensitive_data: new Set([]),
};

function normalizedRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function isSensitiveOrExcluded(relativePath: string): boolean {
  const normalized = normalizedRelativePath(relativePath);
  const parts = normalized.split("/");
  if (parts.some((part) => EXCLUDED_DIRECTORY_NAMES.has(part))) return true;
  const basename = parts.at(-1) ?? "";
  if (PRIVATE_KEY_FILE.test(basename) || SENSITIVE_BASENAME.test(basename)) return true;
  if (basename.startsWith(".env") && !SAFE_ENV_EXAMPLE_NAMES.has(basename)) return true;
  return false;
}

function validateBaseRef(value: string): string {
  if (
    value.startsWith("-") ||
    value.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._/~^-]{0,127}$/u.test(value)
  ) {
    throw new Error("Invalid Git base reference");
  }
  return value;
}

async function captureGitDiff(
  root: string,
  baseRef: string | undefined,
  maximumBytes: number,
): Promise<{ readonly text: string; readonly available: boolean; readonly truncated: boolean }> {
  const ref = baseRef === undefined ? "HEAD" : validateBaseRef(baseRef);
  const commonArguments = [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
  ];

  const capture = async (
    arguments_: readonly string[],
    byteLimit: number,
  ): Promise<{ readonly text: string; readonly available: boolean; readonly truncated: boolean }> => new Promise((resolve) => {
    const child = spawn("git", [...commonArguments, ...arguments_], {
      cwd: root,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    });
    const chunks: Buffer[] = [];
    let byteCount = 0;
    let truncated = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (byteCount >= byteLimit) {
        truncated = true;
        return;
      }
      const remaining = byteLimit - byteCount;
      chunks.push(chunk.subarray(0, remaining));
      byteCount += Math.min(chunk.byteLength, remaining);
      if (chunk.byteLength > remaining) truncated = true;
    });
    child.once("error", () => resolve({ text: "", available: false, truncated: false }));
    child.once("close", (code) => {
      resolve({
        text: Buffer.concat(chunks).toString("utf8"),
        available: code === 0,
        truncated,
      });
    });
  });

  // The staged form compares Git objects and cannot invoke worktree clean
  // filters. Unstaged content is handled below from metadata plus raw blobs.
  const staged = await capture([
    "diff-index", "--cached", "--no-renames", "--no-ext-diff", "--no-textconv", "--unified=0",
    ref, "--",
  ], maximumBytes);
  if (!staged.available || staged.truncated) return staged;

  let combinedText = staged.text;
  let remainingBytes = Math.max(0, maximumBytes - Buffer.byteLength(combinedText, "utf8"));
  if (remainingBytes === 0) {
    return { ...staged, truncated: true };
  }

  // Generating a worktree patch can invoke a repository clean filter. Ask Git
  // only for changed path metadata, then compare the index blob with the raw
  // worktree file in-process. No repository-defined executable is consulted.
  const indexEntries = await capture([
    "ls-files", "--stage", "-z", "--",
  ], remainingBytes);
  const pathRecords = indexEntries.text.split("\0");
  if (indexEntries.truncated) pathRecords.pop();
  let truncated = indexEntries.truncated;
  const trackedPaths = new Set<string>();

  for (const pathRecord of pathRecords) {
    if (pathRecord.length === 0) continue;
    const entry = /^(?:[0-7]{6}) ([0-9a-f]{40,64}) 0\t([\s\S]+)$/u.exec(pathRecord);
    const objectId = entry?.[1];
    const entryPath = entry?.[2];
    if (objectId === undefined || entryPath === undefined) continue;
    const relativePath = normalizedRelativePath(entryPath);
    trackedPaths.add(relativePath);
    if (
      /[\r\n]/u.test(relativePath) ||
      isSensitiveOrExcluded(relativePath) ||
      !SOURCE_LIKE_EXTENSION.test(relativePath)
    ) continue;

    let worktree: Buffer;
    try {
      worktree = await readProjectFileNoFollow(root, relativePath);
    } catch {
      // Deleted and symlinked files contain no safely readable added evidence.
      continue;
    }
    const indexBlob = await capture(["cat-file", "blob", objectId], maximumBytes);
    if (!indexBlob.available) continue;

    const current = truncateUtf8(worktree.toString("utf8"), maximumBytes);
    truncated ||= indexBlob.truncated || current.truncated;
    const oldLineCounts = new Map<string, number>();
    for (const line of indexBlob.text.split(/\r?\n/u)) {
      oldLineCounts.set(line, (oldLineCounts.get(line) ?? 0) + 1);
    }
    const addedLines: string[] = [];
    for (const line of current.text.split(/\r?\n/u)) {
      const oldCount = oldLineCounts.get(line) ?? 0;
      if (oldCount > 0) oldLineCounts.set(line, oldCount - 1);
      else addedLines.push(line);
    }
    if (addedLines.length === 0) continue;

    const syntheticDiff = `diff --git a/${relativePath} b/${relativePath}\n--- a/${relativePath}\n+++ b/${relativePath}\n@@ -0,0 +1,${addedLines.length} @@\n${addedLines.map((line) => `+${line}`).join("\n")}\n`;
    const appended = truncateUtf8(`${combinedText}${syntheticDiff}`, maximumBytes);
    combinedText = appended.text;
    truncated ||= appended.truncated;
    remainingBytes = Math.max(0, maximumBytes - Buffer.byteLength(combinedText, "utf8"));
    if (remainingBytes === 0 || appended.truncated) break;
  }

  // Git does not include ordinary untracked files in diff-index. Enumerate only
  // their names, then read each candidate directly with O_NOFOLLOW. This avoids
  // repository diff drivers and still closes the "new payment.ts not git add'ed"
  // gap before a release scan.
  if (!truncated && remainingBytes > 0) {
    const untracked = await capture([
      "ls-files", "--others", "--exclude-standard", "-z", "--",
    ], remainingBytes);
    const untrackedPaths = untracked.text.split("\0");
    if (untracked.truncated) untrackedPaths.pop();
    truncated ||= untracked.truncated;
    for (const rawPath of untrackedPaths) {
      if (rawPath.length === 0) continue;
      const relativePath = normalizedRelativePath(rawPath);
      if (
        trackedPaths.has(relativePath) ||
        /[\r\n]/u.test(relativePath) ||
        isSensitiveOrExcluded(relativePath) ||
        !SOURCE_LIKE_EXTENSION.test(relativePath)
      ) continue;
      let worktree: Buffer;
      try {
        worktree = await readProjectFileNoFollow(root, relativePath);
      } catch {
        continue;
      }
      const current = truncateUtf8(worktree.toString("utf8"), maximumBytes);
      const lines = current.text.split(/\r?\n/u);
      const syntheticDiff = `diff --git a/${relativePath} b/${relativePath}\n--- /dev/null\n+++ b/${relativePath}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
      const appended = truncateUtf8(`${combinedText}${syntheticDiff}`, maximumBytes);
      combinedText = appended.text;
      truncated ||= current.truncated || appended.truncated;
      remainingBytes = Math.max(0, maximumBytes - Buffer.byteLength(combinedText, "utf8"));
      if (remainingBytes === 0 || appended.truncated) break;
    }
  }

  return {
    text: combinedText,
    available: indexEntries.available,
    truncated,
  };
}

function safeDiffCandidates(diff: string): readonly CandidateText[] {
  const candidates: CandidateText[] = [];
  type DiffState = "outside" | "headers" | "old_header" | "new_header" | "hunk";
  let state: DiffState = "outside";
  const stateIs = (expected: DiffState): boolean => state === expected;
  let currentPath: string | undefined;
  let changedLines: string[] = [];

  const flush = (): void => {
    if (
      currentPath !== undefined &&
      !isSensitiveOrExcluded(currentPath) &&
      changedLines.length > 0
    ) {
      candidates.push({
        source: MIGRATION_PATH.test(currentPath) ? "migration" : "git_diff",
        location: currentPath,
        text: redactSensitiveText(changedLines.join("\n")),
      });
    }
    changedLines = [];
  };

  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("diff --git ")) {
      flush();
      currentPath = undefined;
      changedLines = [];
      state = "headers";
      continue;
    }

    if (stateIs("headers") && line.startsWith("--- ")) {
      state = "old_header";
      continue;
    }
    if (stateIs("old_header") && line.startsWith("+++ b/")) {
      currentPath = normalizedRelativePath(line.slice(6));
      state = "new_header";
      continue;
    }
    if (stateIs("new_header") && line.startsWith("@@ ")) {
      state = "hunk";
      continue;
    }
    if (stateIs("hunk") && line.startsWith("@@ ")) {
      continue;
    }
    if (stateIs("hunk") && line.startsWith("+")) {
      changedLines.push(line.slice(1));
    }
  }
  flush();
  return candidates;
}

async function walkProjectFiles(
  root: string,
  maximumFiles: number,
): Promise<{ readonly files: readonly string[]; readonly limited: boolean }> {
  const files: string[] = [];
  let limited = false;

  const walk = async (relativeDirectory: string): Promise<void> => {
    if (limited) return;
    const absoluteDirectory = path.join(root, relativeDirectory);
    let entries;
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = normalizedRelativePath(path.join(relativeDirectory, entry.name));
      if (isSensitiveOrExcluded(relative)) continue;
      if (entry.isDirectory()) {
        await walk(relative);
      } else if (entry.isFile() && SOURCE_LIKE_EXTENSION.test(entry.name)) {
        files.push(relative);
        if (files.length >= maximumFiles) {
          limited = true;
          return;
        }
      }
    }
  };

  await walk("");
  return { files, limited };
}

async function readProjectFileNoFollow(root: string, relativePath: string): Promise<Buffer> {
  const absolute = path.join(root, relativePath);
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(absolute, fsConstants.O_RDONLY | noFollow);
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new Error("Scanned path is not a regular file");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function dependencyEvidence(raw: string, location: string): readonly ChangeEvidence[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const packageJson = parsed as Record<string, unknown>;
  const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  const names = new Set<string>();
  for (const section of sections) {
    const dependencies = packageJson[section];
    if (dependencies !== null && typeof dependencies === "object" && !Array.isArray(dependencies)) {
      Object.keys(dependencies).forEach((name) => names.add(name.toLowerCase()));
    }
  }

  const evidence: ChangeEvidence[] = [];
  for (const signal of SIGNALS) {
    for (const dependency of EXPLICIT_DEPENDENCIES[signal]) {
      if (names.has(dependency)) {
        evidence.push({
          source: "dependency",
          signal,
          strength: "explicit",
          marker: `dependency:${dependency}`,
          location,
          explanation: `Dedicated ${signal.replace("_", " ")} dependency ${dependency} is declared`,
        });
      }
    }
  }
  return evidence;
}

function environmentNameEvidence(text: string, location: string): readonly CandidateText[] {
  const variableNames = new Set<string>();
  const pattern = /\b([A-Z][A-Z0-9_]{2,})\s*(?:=|:)/gu;
  for (const match of text.matchAll(pattern)) {
    const name = match[1];
    if (name !== undefined) variableNames.add(name);
  }
  if (variableNames.size === 0) return [];
  return [{ source: "environment", location, text: [...variableNames].join("\n") }];
}

function candidateEvidence(candidate: CandidateText): readonly ChangeEvidence[] {
  const evidence: ChangeEvidence[] = [];
  for (const rule of RULES) {
    if (!rule.pattern.test(candidate.text)) continue;
    let strength = rule.strength;
    if (candidate.source === "environment" && strength === "supporting") strength = "explicit";
    if (candidate.source === "migration" && strength === "supporting") strength = "explicit";
    evidence.push({
      source: candidate.source,
      signal: rule.signal,
      strength,
      marker: rule.marker,
      ...(candidate.location === undefined ? {} : { location: candidate.location }),
      explanation: rule.explanation,
    });
  }
  return evidence;
}

function deduplicateEvidence(evidence: readonly ChangeEvidence[]): readonly ChangeEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((entry) => {
    const key = `${entry.signal}\0${entry.source}\0${entry.marker}\0${entry.location ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assessSignal(
  signal: FoundationSignal,
  allEvidence: readonly ChangeEvidence[],
): SignalFinding {
  const evidence = allEvidence.filter((entry) => entry.signal === signal);
  const explicit = evidence.some((entry) => entry.strength === "explicit");
  const independentSupportingSources = new Set(
    evidence
      .filter((entry) => entry.strength === "supporting")
      .map((entry) => entry.source),
  );
  const supportingCount = evidence.filter((entry) => entry.strength === "supporting").length;
  const high = explicit || independentSupportingSources.size >= 2;
  const confidence: SignalConfidence = high
    ? "high"
    : supportingCount > 0
      ? "medium"
      : evidence.length > 0
        ? "low"
        : "none";
  return { signal, confidence, requiresReassessment: high, evidence };
}

export async function scanProjectChanges(
  projectRoot: string,
  options: ChangeScanOptions = {},
): Promise<ChangeScanResult> {
  const root = await resolveProjectRoot(projectRoot, options);
  const maximumDiffBytes = Math.min(Math.max(options.maxDiffBytes ?? 512_000, 1_024), 2_000_000);
  const maximumFiles = Math.min(Math.max(options.maxFiles ?? 2_000, 1), 10_000);
  const maximumFileBytes = Math.min(Math.max(options.maxFileBytes ?? 128_000, 1_024), 512_000);
  const suppliedDiff = options.diff;
  const gitDiff = suppliedDiff === undefined
    ? await captureGitDiff(root, options.baseRef, maximumDiffBytes)
    : { ...truncateUtf8(suppliedDiff, maximumDiffBytes), available: true };
  const diffText = "text" in gitDiff ? gitDiff.text : "";
  const diffTruncated = "truncated" in gitDiff ? gitDiff.truncated : false;
  const evidence: ChangeEvidence[] = [];

  for (const candidate of safeDiffCandidates(diffText)) {
    evidence.push(...candidateEvidence(candidate));
    evidence.push(...environmentNameEvidence(candidate.text, candidate.location ?? "git diff").flatMap(candidateEvidence));
  }

  const walked = await walkProjectFiles(root, maximumFiles);
  for (const relativePath of walked.files) {
    let raw: string;
    try {
      const data = await readProjectFileNoFollow(root, relativePath);
      raw = truncateUtf8(data.toString("utf8"), maximumFileBytes).text;
    } catch {
      continue;
    }
    const basename = path.basename(relativePath).toLowerCase();
    if (basename === "package.json") {
      evidence.push(...dependencyEvidence(raw, relativePath));
    }
    if (MIGRATION_PATH.test(relativePath)) {
      evidence.push(...candidateEvidence({ source: "migration", location: relativePath, text: raw }));
    }
    evidence.push(...environmentNameEvidence(raw, relativePath).flatMap(candidateEvidence));

    // Structure contributes names only. File contents are handled above only for focused sources.
    evidence.push(
      ...candidateEvidence({
        source: "structure",
        location: relativePath,
        text: relativePath.replace(/[._/-]+/gu, " "),
      }),
    );
  }

  const uniqueEvidence = deduplicateEvidence(evidence);
  const findings = Object.fromEntries(
    SIGNALS.map((signal) => [signal, assessSignal(signal, uniqueEvidence)]),
  ) as unknown as Readonly<Record<FoundationSignal, SignalFinding>>;
  const affectedCapabilities = SIGNALS.filter(
    (signal) => findings[signal].requiresReassessment,
  );
  const warnings: string[] = [];
  if (diffTruncated) warnings.push("Git diff was truncated at the configured safety limit");
  if (walked.limited) warnings.push("Project structure scan reached the configured file limit");
  if (!gitDiff.available) warnings.push("Git diff was unavailable; dependency and structure scans still ran");

  return {
    projectRoot: root,
    scannedAt: (options.now ?? (() => new Date()))().toISOString(),
    gitAvailable: gitDiff.available,
    diffTruncated,
    filesInspected: walked.files.length,
    findings,
    affectedCapabilities,
    requiresReassessment: affectedCapabilities.length > 0,
    warnings,
  };
}

export const scanChanges = scanProjectChanges;
