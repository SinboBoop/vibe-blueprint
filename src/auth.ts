import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import type { ReadStream, WriteStream } from "node:tty";

import {
  getCredentialFilePath,
  getLegacyCredentialFilePath,
  getUserConfigDir,
  type ConfigPathOptions,
} from "./config.js";
import { atomicWriteJson } from "./security.js";

interface CredentialDocument {
  readonly version: 1;
  readonly api_key: string;
}

export interface CredentialOptions extends ConfigPathOptions {
  readonly credentialPath?: string;
}

export interface CredentialStatus {
  readonly configured: boolean;
  readonly source: "environment" | "file" | "none";
  readonly credentialFile: string;
  readonly securePermissions: boolean | null;
  readonly detail: string;
}

export interface PromptCredentialOptions extends CredentialOptions {
  readonly input?: ReadStream;
  readonly output?: WriteStream;
  readonly prompt?: string;
}

function primaryCredentialPath(options: CredentialOptions): string {
  return options.credentialPath ?? getCredentialFilePath(options);
}

function legacyCredentialPath(options: CredentialOptions): string | undefined {
  if (options.credentialPath !== undefined) return undefined;
  return getLegacyCredentialFilePath(options);
}

function validateApiKey(value: string): string {
  const apiKey = value.trim();
  if (apiKey.length === 0) throw new Error("API key cannot be empty");
  if (
    apiKey.length > 16_384 ||
    apiKey.includes("\r") ||
    apiKey.includes("\n") ||
    apiKey.includes("\0")
  ) {
    throw new Error("API key contains unsupported characters or is too long");
  }
  return apiKey;
}

async function readCredentialFile(
  filePath: string,
  platform: NodeJS.Platform,
): Promise<{ readonly key: string; readonly securePermissions: boolean }> {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Credential path must be a regular file, not a symbolic link");
  }
  const securePermissions = platform === "win32" || (metadata.mode & 0o077) === 0;
  if (!securePermissions) {
    throw new Error("Credential file permissions are too broad; expected mode 0600");
  }
  if (metadata.size > 32_768) throw new Error("Credential file is unexpectedly large");

  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()) throw new Error("Credential path is not a regular file");
    const raw = await handle.readFile({ encoding: "utf8" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Credential file is not valid JSON");
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { api_key?: unknown }).api_key !== "string"
    ) {
      throw new Error("Credential file has an unsupported format");
    }
    return {
      key: validateApiKey((parsed as CredentialDocument).api_key),
      securePermissions,
    };
  } finally {
    await handle.close();
  }
}

export async function resolveApiKey(options: CredentialOptions = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const fromEnvironment = env.FOUNDATION_LLM_API_KEY?.trim();
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) {
    return validateApiKey(fromEnvironment);
  }

  const platform = options.platform ?? process.platform;
  const primaryPath = primaryCredentialPath(options);
  try {
    return (await readCredentialFile(primaryPath, platform)).key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const legacyPath = legacyCredentialPath(options);
  if (legacyPath !== undefined) {
    try {
      return (await readCredentialFile(legacyPath, platform)).key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

export async function writeCredential(
  apiKey: string,
  options: CredentialOptions = {},
): Promise<string> {
  const key = validateApiKey(apiKey);
  const filePath = primaryCredentialPath(options);
  const directory = options.credentialPath === undefined
    ? getUserConfigDir(options)
    : path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((options.platform ?? process.platform) !== "win32") await chmod(directory, 0o700);
  await atomicWriteJson(filePath, { version: 1, api_key: key }, { mode: 0o600, directoryMode: 0o700 });
  if ((options.platform ?? process.platform) !== "win32") await chmod(filePath, 0o600);
  return filePath;
}

export async function deleteCredential(options: CredentialOptions = {}): Promise<boolean> {
  const candidates = [primaryCredentialPath(options), legacyCredentialPath(options)]
    .filter((candidate): candidate is string => candidate !== undefined);
  let deleted = false;
  for (const candidate of candidates) {
    try {
      await rm(candidate);
      deleted = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return deleted;
}

export async function credentialStatus(
  options: CredentialOptions = {},
): Promise<CredentialStatus> {
  const env = options.env ?? process.env;
  const filePath = primaryCredentialPath(options);
  if ((env.FOUNDATION_LLM_API_KEY?.trim().length ?? 0) > 0) {
    return {
      configured: true,
      source: "environment",
      credentialFile: filePath,
      securePermissions: null,
      detail: "FOUNDATION_LLM_API_KEY is set in the process environment",
    };
  }

  try {
    const credential = await readCredentialFile(filePath, options.platform ?? process.platform);
    return {
      configured: true,
      source: "file",
      credentialFile: filePath,
      securePermissions: credential.securePermissions,
      detail: "A user credential is stored with restricted permissions",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        configured: false,
        source: "none",
        credentialFile: filePath,
        securePermissions: false,
        detail: error instanceof Error ? error.message : "Credential file cannot be read safely",
      };
    }
  }

  const legacyPath = legacyCredentialPath(options);
  if (legacyPath !== undefined) {
    try {
      const credential = await readCredentialFile(
        legacyPath,
        options.platform ?? process.platform,
      );
      return {
        configured: true,
        source: "file",
        credentialFile: legacyPath,
        securePermissions: credential.securePermissions,
        detail: "A legacy user credential is in use with restricted permissions",
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return {
          configured: false,
          source: "none",
          credentialFile: legacyPath,
          securePermissions: false,
          detail: error instanceof Error ? error.message : "Credential file cannot be read safely",
        };
      }
    }
  }

  return {
    configured: false,
    source: "none",
    credentialFile: filePath,
    securePermissions: null,
    detail: "No Vibe Blueprint API key is configured",
  };
}

function readHiddenLine(input: ReadStream, output: WriteStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = input.isRaw;

    const cleanup = (): void => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
    };
    const finish = (): void => {
      cleanup();
      output.write("\n");
      resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      for (const character of text) {
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0003") {
          cleanup();
          output.write("\n");
          reject(new Error("Credential entry cancelled"));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    };

    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

export async function promptAndStoreApiKey(
  options: PromptCredentialOptions = {},
): Promise<string> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  if (!input.isTTY || !output.isTTY) {
    throw new Error("auth set requires an interactive TTY so the API key can be read without echo");
  }
  output.write(options.prompt ?? "Vibe Blueprint model API key (input hidden): ");
  const apiKey = await readHiddenLine(input, output);
  return writeCredential(apiKey, options);
}
