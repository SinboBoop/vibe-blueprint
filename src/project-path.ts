import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { loadConfig, type LoadConfigOptions } from "./config.js";

export interface ResolveProjectRootOptions extends LoadConfigOptions {
  readonly allowedRoots?: readonly string[];
}

export interface ResolveProjectPathOptions extends ResolveProjectRootOptions {
  readonly mustExist?: boolean;
}

function containsNull(value: string): boolean {
  return value.includes("\0");
}

export function isPathInside(candidate: string, allowedRoot: string): boolean {
  const relative = path.relative(allowedRoot, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function canonicalExistingAncestor(candidate: string): Promise<string> {
  try {
    await lstat(candidate);
    return await realpath(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error(`No existing ancestor for path: ${candidate}`);
    return path.join(await canonicalExistingAncestor(parent), path.basename(candidate));
  }
}

async function assertNoSymlinkComponents(root: string, relativePath: string): Promise<void> {
  let current = root;
  for (const segment of relativePath.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink()) {
        throw new Error("Project artifact paths must not contain symlinks (symbolic links)");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export async function resolveAllowedRoots(
  roots: readonly string[],
): Promise<readonly string[]> {
  if (roots.length === 0) throw new Error("At least one allowed root is required");
  const canonical: string[] = [];
  for (const root of roots) {
    if (containsNull(root)) throw new Error("Allowed root contains a NUL byte");
    const resolved = await realpath(path.resolve(root));
    const details = await stat(resolved);
    if (!details.isDirectory()) throw new Error(`Allowed root is not a directory: ${root}`);
    canonical.push(resolved);
  }
  return [...new Set(canonical)];
}

export async function resolveProjectRoot(
  projectRoot: string,
  options: ResolveProjectRootOptions = {},
): Promise<string> {
  if (projectRoot.trim().length === 0 || containsNull(projectRoot)) {
    throw new Error("project_root must be a non-empty filesystem path");
  }
  const candidate = await realpath(path.resolve(options.cwd ?? process.cwd(), projectRoot));
  const details = await stat(candidate);
  if (!details.isDirectory()) throw new Error("project_root must identify a directory");

  const configuredRoots = options.allowedRoots ?? loadConfig(options).allowedRoots;
  const allowedRoots = await resolveAllowedRoots(configuredRoots);
  if (!allowedRoots.some((root) => isPathInside(candidate, root))) {
    throw new Error("project_root is outside FOUNDATION_ALLOWED_ROOTS");
  }
  return candidate;
}

export async function resolveProjectPath(
  projectRoot: string,
  relativePath: string,
  options: ResolveProjectPathOptions = {},
): Promise<string> {
  if (
    relativePath.trim().length === 0 ||
    containsNull(relativePath) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("Project artifact path must be a non-empty relative path");
  }
  const canonicalRoot = await resolveProjectRoot(projectRoot, options);
  const lexicalCandidate = path.resolve(canonicalRoot, relativePath);
  if (!isPathInside(lexicalCandidate, canonicalRoot)) {
    throw new Error("Project artifact path escapes project_root");
  }

  await assertNoSymlinkComponents(canonicalRoot, path.relative(canonicalRoot, lexicalCandidate));

  const canonicalCandidate = await canonicalExistingAncestor(lexicalCandidate);
  if (!isPathInside(canonicalCandidate, canonicalRoot)) {
    throw new Error("Project artifact path resolves outside project_root through a symlink");
  }
  if (options.mustExist === true) {
    await stat(canonicalCandidate);
  }
  return canonicalCandidate;
}

export async function assertPathInsideProject(
  projectRoot: string,
  candidatePath: string,
  options: ResolveProjectRootOptions = {},
): Promise<string> {
  const canonicalRoot = await resolveProjectRoot(projectRoot, options);
  const canonicalCandidate = await canonicalExistingAncestor(path.resolve(candidatePath));
  if (!isPathInside(canonicalCandidate, canonicalRoot)) {
    throw new Error("Path is outside project_root");
  }
  return canonicalCandidate;
}
