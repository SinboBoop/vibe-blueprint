import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { commitFoundation } from "../../src/state.js";
import { previewEvidenceCheck, runEvidenceCheck } from "../../src/verifier.js";

const temporaryDirectories: string[] = [];

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function sourceHash(value: Readonly<Record<string, unknown>>): string {
  const withoutHash = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "source_hash"),
  );
  return createHash("sha256").update(JSON.stringify(stableValue(withoutHash))).digest("hex");
}

async function projectDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "foundation-verify-test-"));
  temporaryDirectories.push(directory);
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      scripts: { evidence: "node --test" },
    }),
  );
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Foundation verifier", () => {
  it("previews and runs only a registered, allowlisted check and records redacted evidence", async () => {
    const project = await projectDirectory();
    const options = { allowedRoots: [project], now: () => new Date("2026-01-01T00:00:00.000Z") };
    await commitFoundation(project, {
      project_summary: "Verifier fixture",
      evidence_checks: [
        {
          id: "unit-test",
          description: "Run the built-in test runner",
          command: "npm",
          args: ["run", "evidence"],
          timeout_ms: 30_000,
          max_output_bytes: 8_192,
        },
      ],
    }, options);

    await expect(previewEvidenceCheck(project, "unit-test", options)).resolves.toMatchObject({
      mode: "preview",
      executable: "npm",
      args: ["run", "evidence"],
      packageScriptSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown,
      foundationRevision: 1,
      foundationSourceHash: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown,
    });
    const result = await runEvidenceCheck(project, "unit-test", options);
    expect(result.record.status).toBe("passed");
    expect(result.record.timestamp).toBe("2026-01-01T00:00:00.000Z");
    expect(result.record.foundation_revision).toBe(1);
    expect(result.record.foundation_source_hash).toMatch(/^[0-9a-f]{64}$/u);
    const evidence = JSON.parse(await readFile(result.evidenceFile, "utf8")) as { records: unknown[] };
    expect(evidence.records).toHaveLength(1);
  });

  it("fails closed when a registered package script or lifecycle hook changes", async () => {
    const project = await projectDirectory();
    const options = { allowedRoots: [project] };
    await commitFoundation(project, {
      evidence_checks: [{ id: "bound", command: "npm", args: ["run", "evidence"] }],
    }, options);
    const foundation = JSON.parse(await readFile(
      path.join(project, ".project-foundation", "foundation.json"),
      "utf8",
    )) as { evidence_checks: Array<{ package_script_sha256?: string }> };
    expect(foundation.evidence_checks[0]?.package_script_sha256).toMatch(/^[0-9a-f]{64}$/u);

    await writeFile(path.join(project, "package.json"), JSON.stringify({
      scripts: {
        preevidence: "node -e \"process.stdout.write('changed')\"",
        evidence: "node --test",
      },
    }));

    await expect(previewEvidenceCheck(project, "bound", options)).rejects.toThrow(
      "package script changed after registration",
    );
    await expect(runEvidenceCheck(project, "bound", options)).rejects.toThrow(
      "package script changed after registration",
    );
  });

  it("rejects a legacy package-manager check without a binding but permits node --test", async () => {
    const project = await projectDirectory();
    const options = { allowedRoots: [project] };
    await commitFoundation(project, {
      evidence_checks: [{ id: "legacy", command: "npm", args: ["run", "evidence"] }],
    }, options);
    const statePath = path.join(project, ".project-foundation", "foundation.json");
    const legacy = JSON.parse(await readFile(statePath, "utf8")) as {
      evidence_checks: Array<{ package_script_sha256?: string }>;
      source_hash: string;
      [key: string]: unknown;
    };
    delete legacy.evidence_checks[0]?.package_script_sha256;
    legacy.source_hash = sourceHash(legacy);
    await writeFile(statePath, JSON.stringify(legacy));
    await expect(previewEvidenceCheck(project, "legacy", options)).rejects.toThrow(
      "has no package script binding; re-register and commit",
    );

    const nodeProject = await projectDirectory();
    await commitFoundation(nodeProject, {
      evidence_checks: [{ id: "node", command: "node", args: ["--test"] }],
    }, { allowedRoots: [nodeProject] });
    await expect(previewEvidenceCheck(nodeProject, "node", { allowedRoots: [nodeProject] }))
      .resolves.toMatchObject({ executable: "node", args: ["--test"] });
  });

  it("rejects shell injection in registered arguments before spawning", async () => {
    const project = await projectDirectory();
    const marker = path.join(project, "injected-marker");
    const options = { allowedRoots: [project] };
    await commitFoundation(project, {
      evidence_checks: [
        {
          id: "injection",
          command: "npm",
          args: ["test", `;touch ${marker}`],
        },
      ],
    }, options);

    await expect(runEvidenceCheck(project, "injection", options)).rejects.toThrow("unsafe shell");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unregistered checks and non-allowlisted executables", async () => {
    const project = await projectDirectory();
    const options = { allowedRoots: [project] };
    await commitFoundation(project, {
      evidence_checks: [{ id: "unsafe", command: "sh", args: ["-c", "true"] }],
    }, options);

    await expect(previewEvidenceCheck(project, "missing", options)).rejects.toThrow("not registered");
    await expect(previewEvidenceCheck(project, "unsafe", options)).rejects.toThrow("not allowlisted");
  });

  it.each([
    ["npm", ["run", "--prefix", "/outside", "evil"]],
    ["npm", ["run", "evil", "--prefix", "/outside"]],
    ["pnpm", ["run", "--dir", "/outside", "evil"]],
    ["bun", ["test", "--cwd", "/outside"]],
  ])("rejects package-manager cwd redirection via %s", async (command, args) => {
    const project = await projectDirectory();
    const options = { allowedRoots: [project] };
    await commitFoundation(project, {
      evidence_checks: [{ id: "redirect", command, args }],
    }, options);
    await expect(previewEvidenceCheck(project, "redirect", options)).rejects.toThrow(/cannot|must/u);
  });

  it.each([
    ["--test", "--test-reporter=/outside/reporter.mjs"],
    ["--test", "--test-reporter-destination=/outside/results.txt"],
  ])("rejects unsafe direct-node test option %s %s", async (...args) => {
    const project = await projectDirectory();
    const options = { allowedRoots: [project] };
    await commitFoundation(project, {
      evidence_checks: [{ id: "node-option", command: "node", args }],
    }, options);
    await expect(previewEvidenceCheck(project, "node-option", options)).rejects.toThrow("exactly");
  });
});
