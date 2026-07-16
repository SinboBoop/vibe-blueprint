import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface AtomicWriteOptions {
  readonly mode?: number;
  readonly directoryMode?: number;
}

const REDACTED = "[REDACTED]";

export function redactSensitiveText(input: string): string {
  return input
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/giu, `$1${REDACTED}@`)
    .replace(
      /((?:proxy-)?authorization\s*["']?\s*[:=]\s*["']?)(?:bearer|basic)?\s*[^\s"',;}\]]+/giu,
      `$1${REDACTED}`,
    )
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{4,}/giu, `Bearer ${REDACTED}`)
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/gu, REDACTED)
    .replace(/\b(?:npm_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu, REDACTED)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, REDACTED)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, REDACTED)
    .replace(
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|_authToken|client[_-]?secret|secret[_-]?access[_-]?key|password)\s*["']?\s*[:=]\s*["']?)\s*[^\s"',;}\]]+/giu,
      `$1${REDACTED}`,
    );
}

function isSensitiveKey(key: string): boolean {
  return /(?:authorization|api[_-]?key|token|password|secret|credential)/iu.test(key);
}

export function redactSensitiveValue(value: unknown, seen = new WeakSet()): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((entry) => redactSensitiveValue(entry, seen));
    seen.delete(value);
    return result;
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redactSensitiveValue(entry, seen);
  }
  seen.delete(value);
  return output;
}

export function sanitizeError(error: unknown): Error {
  if (error instanceof Error) {
    const sanitized = new Error(redactSensitiveText(error.message));
    sanitized.name = error.name;
    if (error.stack !== undefined) sanitized.stack = redactSensitiveText(error.stack);
    return sanitized;
  }
  return new Error(redactSensitiveText(String(error)));
}

export function safeErrorMessage(error: unknown): string {
  return sanitizeError(error).message;
}

export async function atomicWriteFile(
  filePath: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = path.dirname(filePath);
  const fileMode = options.mode ?? 0o600;
  await mkdir(directory, { recursive: true, mode: options.directoryMode ?? 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      fileMode,
    );
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, fileMode);
    await rename(temporaryPath, filePath);

    // Best-effort directory sync makes the rename durable on POSIX filesystems.
    try {
      const directoryHandle = await open(directory, fsConstants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      // Some platforms do not permit opening directories. The atomic rename still succeeded.
    }
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw sanitizeError(error);
  }
}

export async function atomicWriteJson(
  filePath: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

export function truncateUtf8(input: string, maximumBytes: number): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const bytes = Buffer.from(input, "utf8");
  if (bytes.byteLength <= maximumBytes) return { text: input, truncated: false };
  return {
    text: bytes.subarray(0, Math.max(0, maximumBytes)).toString("utf8").replace(/\uFFFD$/u, ""),
    truncated: true,
  };
}
