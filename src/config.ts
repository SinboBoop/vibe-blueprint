import path from "node:path";
import os from "node:os";

import { DEFAULT_LLM_CONFIG } from "./constants.js";

export type CodeSharingMode = "none" | "summary" | "diff";

export interface ConfigPathOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
}

export interface LoadConfigOptions extends ConfigPathOptions {
  readonly cwd?: string;
}

export interface FoundationConfig {
  readonly llmBaseUrl: string;
  readonly llmResponsesPath?: string | undefined;
  readonly llmModel: string;
  readonly llmReasoningEffort: string;
  readonly codeSharing: CodeSharingMode;
  readonly allowedRoots: readonly string[];
  readonly userConfigDir: string;
  readonly credentialFile: string;
}

export interface ConfigDiagnostics {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly effective: {
    readonly llmBaseUrl: string;
    readonly llmResponsesPath: string | null;
    readonly llmModel: string;
    readonly llmReasoningEffort: string;
    readonly codeSharing: CodeSharingMode;
    readonly allowedRoots: readonly string[];
    readonly credentialFile: string;
    readonly apiKeyInEnvironment: boolean;
  };
}

const CODE_SHARING_MODES = new Set<CodeSharingMode>(["none", "summary", "diff"]);
const CURRENT_CONFIG_DIRECTORY_NAME = "vibe-blueprint";
const LEGACY_CONFIG_DIRECTORY_NAME = "foundation-guard";

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function isPermittedLlmBaseUrl(url: URL): boolean {
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
}

function validateHttpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("FOUNDATION_LLM_BASE_URL must be a valid absolute URL");
  }
  if (!isPermittedLlmBaseUrl(parsed)) {
    throw new Error(
      "FOUNDATION_LLM_BASE_URL must use HTTPS; HTTP is allowed only for a loopback test server",
    );
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error("FOUNDATION_LLM_BASE_URL must not contain credentials");
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/u, "");
}

function validateResponsesPath(value: string | undefined): string | undefined {
  const candidate = nonEmpty(value);
  if (candidate === undefined) return undefined;
  if (
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("?") ||
    candidate.includes("#") ||
    Array.from(candidate).some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error("FOUNDATION_LLM_RESPONSES_PATH must be an absolute URL path such as /responses");
  }
  return candidate;
}

function getPlatformConfigDir(
  directoryName: string,
  options: ConfigPathOptions,
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();

  const xdg = nonEmpty(env.XDG_CONFIG_HOME);
  if (xdg !== undefined) return path.resolve(xdg, directoryName);

  if (platform === "win32") {
    const appData = nonEmpty(env.APPDATA);
    if (appData !== undefined) return path.resolve(appData, directoryName);
  }

  return path.resolve(homeDir, ".config", directoryName);
}

export function getUserConfigDir(options: ConfigPathOptions = {}): string {
  const env = options.env ?? process.env;
  const explicit = nonEmpty(env.FOUNDATION_CONFIG_DIR);
  if (explicit !== undefined) return path.resolve(explicit);
  return getPlatformConfigDir(CURRENT_CONFIG_DIRECTORY_NAME, options);
}

export function getCredentialFilePath(options: ConfigPathOptions = {}): string {
  return path.join(getUserConfigDir(options), "credentials.json");
}

/**
 * Return the pre-rename credential location when the platform default is in
 * use. An explicit FOUNDATION_CONFIG_DIR is authoritative and has no legacy
 * fallback outside that directory.
 */
export function getLegacyCredentialFilePath(
  options: ConfigPathOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  if (nonEmpty(env.FOUNDATION_CONFIG_DIR) !== undefined) return undefined;
  return path.join(
    getPlatformConfigDir(LEGACY_CONFIG_DIRECTORY_NAME, options),
    "credentials.json",
  );
}

export function parseAllowedRoots(raw: string | undefined, cwd = process.cwd()): readonly string[] {
  const configured = nonEmpty(raw);
  if (configured === undefined) return [path.resolve(cwd)];

  const roots = configured
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => path.resolve(entry));
  if (roots.length === 0) {
    throw new Error("FOUNDATION_ALLOWED_ROOTS must contain at least one path");
  }
  return [...new Set(roots)];
}

export function loadConfig(options: LoadConfigOptions = {}): FoundationConfig {
  const env = options.env ?? process.env;
  const codeSharingValue = nonEmpty(env.FOUNDATION_CODE_SHARING) ?? DEFAULT_LLM_CONFIG.codeSharing;
  if (!CODE_SHARING_MODES.has(codeSharingValue as CodeSharingMode)) {
    throw new Error("FOUNDATION_CODE_SHARING must be one of: none, summary, diff");
  }

  const model = nonEmpty(env.FOUNDATION_LLM_MODEL) ?? DEFAULT_LLM_CONFIG.model;
  const reasoningEffort =
    nonEmpty(env.FOUNDATION_LLM_REASONING_EFFORT) ?? DEFAULT_LLM_CONFIG.reasoningEffort;

  return {
    llmBaseUrl: validateHttpUrl(
      nonEmpty(env.FOUNDATION_LLM_BASE_URL) ?? DEFAULT_LLM_CONFIG.baseUrl,
    ),
    ...(validateResponsesPath(env.FOUNDATION_LLM_RESPONSES_PATH) === undefined
      ? {}
      : { llmResponsesPath: validateResponsesPath(env.FOUNDATION_LLM_RESPONSES_PATH) }),
    llmModel: model,
    llmReasoningEffort: reasoningEffort,
    codeSharing: codeSharingValue as CodeSharingMode,
    allowedRoots: parseAllowedRoots(env.FOUNDATION_ALLOWED_ROOTS, options.cwd),
    userConfigDir: getUserConfigDir(options),
    credentialFile: getCredentialFilePath(options),
  };
}

export function getConfigDiagnostics(options: LoadConfigOptions = {}): ConfigDiagnostics {
  const env = options.env ?? process.env;
  const errors: string[] = [];
  let config: FoundationConfig;
  try {
    config = loadConfig(options);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Invalid Vibe Blueprint configuration");
    config = loadConfig({ ...options, env: {} });
  }

  const warnings: string[] = [];
  if (config.codeSharing === "diff") {
    warnings.push("Code sharing is set to diff; only redacted, size-limited diffs may be sent");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    effective: {
      llmBaseUrl: config.llmBaseUrl,
      llmResponsesPath: config.llmResponsesPath ?? null,
      llmModel: config.llmModel,
      llmReasoningEffort: config.llmReasoningEffort,
      codeSharing: config.codeSharing,
      allowedRoots: config.allowedRoots,
      credentialFile: config.credentialFile,
      apiKeyInEnvironment: nonEmpty(env.FOUNDATION_LLM_API_KEY) !== undefined,
    },
  };
}
