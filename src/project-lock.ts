import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import lockfile from "proper-lockfile";

import { getUserConfigDir } from "./config.js";

const projectQueues = new Map<string, Promise<void>>();

async function acquireFileLock(projectRoot: string): Promise<() => Promise<void>> {
  const locksDirectory = path.join(getUserConfigDir(), "locks");
  await mkdir(locksDirectory, { recursive: true, mode: 0o700 });
  const target = path.join(locksDirectory, createHash("sha256").update(projectRoot).digest("hex"));
  const release = await lockfile.lock(target, {
    realpath: false,
    stale: 15_000,
    update: 5_000,
    retries: { retries: 120, factor: 1, minTimeout: 25, maxTimeout: 25 },
  });
  return release;
}

export async function withProjectMutationLock<T>(
  projectRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const prior = projectQueues.get(projectRoot) ?? Promise.resolve();
  let releaseQueue: (() => void) | undefined;
  const current = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const tail = prior.then(() => current);
  projectQueues.set(projectRoot, tail);
  await prior;
  let releaseFileLock: (() => Promise<void>) | undefined;
  try {
    releaseFileLock = await acquireFileLock(projectRoot);
    return await operation();
  } finally {
    await releaseFileLock?.();
    releaseQueue?.();
    if (projectQueues.get(projectRoot) === tail) projectQueues.delete(projectRoot);
  }
}
