import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  resolveProjectPath,
  resolveProjectRoot,
  type ResolveProjectRootOptions,
} from "./project-path.js";
import { withProjectMutationLock } from "./project-lock.js";
import {
  atomicWriteJson,
  redactSensitiveText,
  truncateUtf8,
} from "./security.js";
import {
  computeEvidenceCheckPackageScriptHash,
  evidenceCheckPackageScriptName,
  FOUNDATION_ARTIFACT_PATHS,
  readFoundation,
  type EvidenceCheck,
} from "./state.js";

export type VerificationMode = "preview" | "run";
export type VerificationStatus = "passed" | "failed" | "timed_out" | "spawn_error";

export interface VerifyRequest {
  readonly checkId: string;
  readonly mode?: VerificationMode;
}

export interface VerificationPreview {
  readonly mode: "preview";
  readonly checkId: string;
  readonly description?: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly packageScriptSha256?: string;
  readonly foundationRevision: number;
  readonly foundationSourceHash: string;
}

export interface VerificationRecord {
  readonly check_id: string;
  readonly description?: string;
  readonly status: VerificationStatus;
  readonly commit: string | null;
  readonly foundation_revision: number;
  readonly foundation_source_hash: string;
  readonly timestamp: string;
  readonly duration_ms: number;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exit_code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timed_out: boolean;
  readonly output: string;
  readonly output_truncated: boolean;
  readonly error?: string;
}

export interface VerificationEvidenceDocument {
  readonly schema_version: 1;
  readonly records: readonly VerificationRecord[];
}

export interface VerificationRunResult {
  readonly mode: "run";
  readonly record: VerificationRecord;
  readonly evidenceFile: string;
}

export type VerificationResult = VerificationPreview | VerificationRunResult;

export interface VerifierOptions extends ResolveProjectRootOptions {
  readonly now?: () => Date;
  readonly environment?: NodeJS.ProcessEnv;
}

interface PreparedCheck {
  readonly check: EvidenceCheck;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly packageScriptSha256?: string;
  readonly foundationRevision: number;
  readonly foundationSourceHash: string;
}

interface CapturedProcess {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly output: string;
  readonly outputTruncated: boolean;
  readonly error?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 4_096;
const ALLOWED_EXECUTABLES = new Set([
  "npm",
  "npm.cmd",
  "pnpm",
  "pnpm.cmd",
  "yarn",
  "yarn.cmd",
  "bun",
  "bun.exe",
  "node",
  "node.exe",
]);

function hasInjectionCharacters(value: string): boolean {
  return [";", "&", "|", "`", "$", "<", ">", "\r", "\n", "\0"].some((character) =>
    value.includes(character),
  );
}

function validateCheckId(checkId: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(checkId)) {
    throw new Error("Invalid evidence check id");
  }
  return checkId;
}

function validateExecutable(command: string): string {
  const normalized = process.platform === "win32" ? command.toLowerCase() : command;
  if (
    command !== path.basename(command) ||
    command.trim() !== command ||
    hasInjectionCharacters(command) ||
    /\s/u.test(command) ||
    !ALLOWED_EXECUTABLES.has(normalized)
  ) {
    throw new Error(`Evidence executable is not allowlisted: ${command}`);
  }
  return command;
}

function validateArguments(args: readonly string[]): readonly string[] {
  if (args.length > MAX_ARGUMENTS) throw new Error("Evidence check has too many arguments");
  return args.map((argument) => {
    if (
      typeof argument !== "string" ||
      Buffer.byteLength(argument, "utf8") > MAX_ARGUMENT_BYTES ||
      hasInjectionCharacters(argument) ||
      redactSensitiveText(argument) !== argument
    ) {
      throw new Error("Evidence check argument contains unsafe shell, control, or secret material");
    }
    return argument;
  });
}

function validateCommandPolicy(executable: string, args: readonly string[]): void {
  const basename = executable.toLowerCase();
  const validatePackageScriptGrammar = (manager: string): void => {
    const first = args[0];
    if (first !== "test" && first !== "run") {
      throw new Error(`${manager} evidence checks may only use test or run <script>`);
    }
    if (first === "run") {
      const script = args[1];
      if (script === undefined || script.startsWith("-") || !/^[A-Za-z0-9:_-]+$/u.test(script)) {
        throw new Error(`${manager} run evidence checks must name a safe package script`);
      }
      if (args.length !== 2) {
        throw new Error(`${manager} run evidence checks cannot add package-manager options or arguments`);
      }
    } else if (args.length !== 1) {
      throw new Error(`${manager} test evidence checks cannot add package-manager options or path operands`);
    }
  };
  if (basename === "node" || basename === "node.exe") {
    if (args.length !== 1 || args[0] !== "--test") {
      throw new Error("The node executable is restricted to exactly `node --test`; use a registered package script for configured tests");
    }
    return;
  }

  if (basename.startsWith("npm")) {
    validatePackageScriptGrammar("npm");
    return;
  }

  if (basename.startsWith("pnpm")) {
    validatePackageScriptGrammar("pnpm");
    return;
  }

  if (basename.startsWith("yarn") || basename.startsWith("bun")) {
    validatePackageScriptGrammar(basename.startsWith("yarn") ? "yarn" : "bun");
  }
}

async function validatePackageScriptBinding(
  root: string,
  check: EvidenceCheck,
  options: VerifierOptions,
): Promise<string | undefined> {
  const scriptName = evidenceCheckPackageScriptName(check);
  if (scriptName === null) return undefined;
  // Invalid package-manager grammar is reported by validateCommandPolicy first.
  if (scriptName === undefined) return undefined;
  if (check.package_script_sha256 === undefined) {
    throw new Error(
      `Evidence check ${check.id} has no package script binding; re-register and commit this evidence check before previewing or running it`,
    );
  }
  const current = await computeEvidenceCheckPackageScriptHash(root, check, options);
  if (current === null || current === undefined || current !== check.package_script_sha256) {
    throw new Error(
      `Evidence check ${check.id} package script changed after registration; review, re-register, and commit the check before running it`,
    );
  }
  return current;
}

function validatedBoundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  field: string,
): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result <= 0 || result > maximum) {
    throw new Error(`${field} must be a positive integer no greater than ${maximum}`);
  }
  return result;
}

async function prepareCheck(
  projectRoot: string,
  checkId: string,
  options: VerifierOptions,
): Promise<PreparedCheck> {
  const root = await resolveProjectRoot(projectRoot, options);
  const foundation = await readFoundation(root, options);
  if (foundation === null) throw new Error("No committed Foundation exists for this project");
  const check = foundation.evidence_checks.find((candidate) => candidate.id === validateCheckId(checkId));
  if (check === undefined) throw new Error(`Evidence check is not registered in Foundation: ${checkId}`);

  const executable = validateExecutable(check.command);
  const args = validateArguments(check.args);
  validateCommandPolicy(executable, args);
  const cwd = check.cwd === undefined
    ? root
    : await resolveProjectPath(root, check.cwd, { ...options, mustExist: true });
  const timeoutMs = validatedBoundedInteger(
    check.timeout_ms,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    "Evidence timeout",
  );
  const maxOutputBytes = validatedBoundedInteger(
    check.max_output_bytes,
    DEFAULT_OUTPUT_BYTES,
    MAX_OUTPUT_BYTES,
    "Evidence output cap",
  );
  const packageScriptSha256 = await validatePackageScriptBinding(root, check, options);
  return {
    check,
    executable,
    args,
    cwd,
    timeoutMs,
    maxOutputBytes,
    ...(packageScriptSha256 === undefined ? {} : { packageScriptSha256 }),
    foundationRevision: foundation.revision,
    foundationSourceHash: foundation.source_hash,
  };
}

function safeChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  const safeNames = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "ComSpec",
    "LANG",
    "LC_ALL",
  ];
  for (const name of safeNames) {
    const value = source[name];
    if (value !== undefined) output[name] = value;
  }
  output.CI = "1";
  output.NO_COLOR = "1";
  output.FORCE_COLOR = "0";
  return output;
}

function appendCapped(
  chunks: Buffer[],
  chunk: Buffer,
  state: { bytes: number; truncated: boolean },
  maximumBytes: number,
): void {
  if (state.bytes >= maximumBytes) {
    state.truncated = true;
    return;
  }
  const remaining = maximumBytes - state.bytes;
  chunks.push(chunk.subarray(0, remaining));
  state.bytes += Math.min(chunk.byteLength, remaining);
  if (chunk.byteLength > remaining) state.truncated = true;
}

async function captureProcess(
  check: PreparedCheck,
  environment: NodeJS.ProcessEnv,
): Promise<CapturedProcess> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const outputState = { bytes: 0, truncated: false };
    let timedOut = false;
    let spawnError: string | undefined;
    let settled = false;

    const child = spawn(check.executable, [...check.args], {
      cwd: check.cwd,
      env: safeChildEnvironment(environment),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    // Capture a bounded overlap so a credential that crosses the configured
    // output boundary is still fully visible to the redactor.
    const captureLimit = Math.min(check.maxOutputBytes + 4_096, MAX_OUTPUT_BYTES + 4_096);
    child.stdout.on("data", (chunk: Buffer) => {
      appendCapped(chunks, chunk, outputState, captureLimit);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      appendCapped(chunks, chunk, outputState, captureLimit);
    });
    child.once("error", (error) => {
      spawnError = redactSensitiveText(error.message);
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      const killTree = (signal: NodeJS.Signals): void => {
        if (process.platform !== "win32" && child.pid !== undefined) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // Fall back to the direct child if its process group already exited.
          }
        }
        child.kill(signal);
      };
      killTree("SIGTERM");
      const forceKill = setTimeout(() => killTree("SIGKILL"), 500);
      forceKill.unref();
    }, check.timeoutMs);
    timeout.unref();

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      let captured = Buffer.concat(chunks).toString("utf8");
      const boundaryTruncated = outputState.truncated || Buffer.byteLength(captured, "utf8") > check.maxOutputBytes;
      if (boundaryTruncated) {
        const bounded = truncateUtf8(captured, check.maxOutputBytes).text;
        const lastCompleteLine = bounded.lastIndexOf("\n");
        // Never persist a partial final line: it may be the prefix of a token
        // whose terminating delimiter fell beyond the output cap.
        captured = lastCompleteLine < 0 ? "" : bounded.slice(0, lastCompleteLine + 1);
      }
      const redacted = redactSensitiveText(captured);
      const finalOutput = truncateUtf8(redacted, check.maxOutputBytes);
      resolve({
        exitCode,
        signal,
        timedOut,
        output: finalOutput.text,
        outputTruncated: boundaryTruncated || finalOutput.truncated,
        ...(spawnError === undefined ? {} : { error: spawnError }),
      });
    };
    child.once("close", finish);
  });
}

async function captureCommit(root: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "rev-parse", "--verify", "HEAD"], {
      cwd: root,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: safeChildEnvironment(process.env),
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      if (bytes < 128) chunks.push(chunk.subarray(0, 128 - bytes));
      bytes += chunk.byteLength;
    });
    child.once("error", () => resolve(null));
    child.once("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const hash = Buffer.concat(chunks).toString("utf8").trim();
      resolve(/^[0-9a-f]{40,64}$/u.test(hash) ? hash : null);
    });
  });
}

function parseEvidenceDocument(raw: string): VerificationEvidenceDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("evidence.json is invalid; refusing to overwrite evidence history");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    (parsed as { schema_version?: unknown }).schema_version !== 1 ||
    !Array.isArray((parsed as { records?: unknown }).records)
  ) {
    throw new Error("evidence.json has an unsupported format");
  }
  return parsed as VerificationEvidenceDocument;
}

async function appendEvidenceUnlocked(
  evidenceFile: string,
  record: VerificationRecord,
): Promise<void> {
  let document: VerificationEvidenceDocument = { schema_version: 1, records: [] };
  try {
    document = parseEvidenceDocument(await readFile(evidenceFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWriteJson(
    evidenceFile,
    { schema_version: 1, records: [...document.records, record] },
    { mode: 0o644 },
  );
}

export async function previewEvidenceCheck(
  projectRoot: string,
  checkId: string,
  options: VerifierOptions = {},
): Promise<VerificationPreview> {
  const check = await prepareCheck(projectRoot, checkId, options);
  return {
    mode: "preview",
    checkId: check.check.id,
    ...(check.check.description === undefined ? {} : { description: check.check.description }),
    executable: check.executable,
    args: check.args.map(redactSensitiveText),
    cwd: check.cwd,
    timeoutMs: check.timeoutMs,
    maxOutputBytes: check.maxOutputBytes,
    ...(check.packageScriptSha256 === undefined
      ? {}
      : { packageScriptSha256: check.packageScriptSha256 }),
    foundationRevision: check.foundationRevision,
    foundationSourceHash: check.foundationSourceHash,
  };
}

export async function runEvidenceCheck(
  projectRoot: string,
  checkId: string,
  options: VerifierOptions = {},
): Promise<VerificationRunResult> {
  const root = await resolveProjectRoot(projectRoot, options);
  const check = await prepareCheck(root, checkId, options);
  const startedAt = options.now?.() ?? new Date();
  const monotonicStart = performance.now();
  const [captured, commit] = await Promise.all([
    captureProcess(check, options.environment ?? process.env),
    captureCommit(root),
  ]);
  const duration = Math.max(0, Math.round(performance.now() - monotonicStart));
  const status: VerificationStatus = captured.timedOut
    ? "timed_out"
    : captured.error !== undefined
      ? "spawn_error"
      : captured.exitCode === 0
        ? "passed"
        : "failed";
  const relativeCwd = path.relative(root, check.cwd) || ".";
  const record: VerificationRecord = {
    check_id: check.check.id,
    ...(check.check.description === undefined ? {} : { description: check.check.description }),
    status,
    commit,
    foundation_revision: check.foundationRevision,
    foundation_source_hash: check.foundationSourceHash,
    timestamp: startedAt.toISOString(),
    duration_ms: duration,
    executable: check.executable,
    args: check.args.map(redactSensitiveText),
    cwd: relativeCwd,
    exit_code: captured.exitCode,
    signal: captured.signal,
    timed_out: captured.timedOut,
    output: captured.output,
    output_truncated: captured.outputTruncated,
    ...(captured.error === undefined ? {} : { error: captured.error }),
  };
  const evidenceFile = await resolveProjectPath(
    root,
    FOUNDATION_ARTIFACT_PATHS.evidenceJson,
    options,
  );
  await withProjectMutationLock(root, () => appendEvidenceUnlocked(evidenceFile, record));
  return { mode: "run", record, evidenceFile };
}

export async function verifyFoundation(
  projectRoot: string,
  request: VerifyRequest,
  options: VerifierOptions = {},
): Promise<VerificationResult> {
  return request.mode === "run"
    ? runEvidenceCheck(projectRoot, request.checkId, options)
    : previewEvidenceCheck(projectRoot, request.checkId, options);
}
