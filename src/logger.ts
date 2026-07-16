import type { Writable } from "node:stream";

import { redactSensitiveText, redactSensitiveValue, safeErrorMessage } from "./security.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface LoggerOptions {
  readonly stream?: Writable;
  readonly minimumLevel?: LogLevel;
  readonly now?: () => Date;
}

const LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function serializeData(data: unknown): unknown {
  if (data instanceof Error) {
    return { name: data.name, message: safeErrorMessage(data) };
  }
  return redactSensitiveValue(data);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const stream = options.stream ?? process.stderr;
  const minimumLevel = options.minimumLevel ?? "info";
  const now = options.now ?? (() => new Date());

  const log = (level: LogLevel, message: string, data?: unknown): void => {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minimumLevel]) return;
    const record: Record<string, unknown> = {
      timestamp: now().toISOString(),
      level,
      message: redactSensitiveText(message),
    };
    if (data !== undefined) record.data = serializeData(data);
    stream.write(`${JSON.stringify(record)}\n`);
  };

  return {
    debug: (message, data) => log("debug", message, data),
    info: (message, data) => log("info", message, data),
    warn: (message, data) => log("warn", message, data),
    error: (message, data) => log("error", message, data),
  };
}

export const logger = createLogger();
