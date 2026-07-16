import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { scanProjectChanges, type FoundationSignal } from "../../src/change-scanner.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

async function projectDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "foundation-scan-test-"));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, "package.json"), '{"dependencies":{}}\n');
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function diffFor(file: string, addedLine: string): string {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+${addedLine}\n`;
}

describe("change scanner confidence", () => {
  it("does not execute repository Git clean filters", async () => {
    const project = await projectDirectory();
    const marker = path.join(project, "FILTER_EXECUTED");
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: project });
    await writeFile(path.join(project, ".gitattributes"), "*.foo filter=pwn\n");
    await writeFile(path.join(project, "sample.foo"), "initial\n");
    await execFileAsync("git", ["add", "."], { cwd: project });
    await execFileAsync("git", ["-c", "filter.pwn.clean=cat", "commit", "-qm", "fixture"], { cwd: project });
    await execFileAsync("git", ["config", "filter.pwn.clean", `touch ${marker}`], { cwd: project });
    await writeFile(path.join(project, "sample.foo"), "changed\n");

    await scanProjectChanges(project, { allowedRoots: [project] });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects explicit payment evidence in an unstaged tracked source change", async () => {
    const project = await projectDirectory();
    await mkdir(path.join(project, "src"));
    const source = path.join(project, "src", "billing.ts");
    await writeFile(source, "export const callback = null;\n");
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: project });
    await execFileAsync("git", ["add", "."], { cwd: project });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: project });
    await writeFile(source, "export const callback = stripe.webhooks.constructEvent;\n");

    const result = await scanProjectChanges(project, { allowedRoots: [project] });

    expect(result.findings.payment.confidence).toBe("high");
    expect(result.findings.payment.requiresReassessment).toBe(true);
    expect(result.findings.payment.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "git_diff", location: "src/billing.ts" }),
    ]));
  });

  it("detects explicit evidence in an untracked source file without executing Git filters", async () => {
    const project = await projectDirectory();
    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: project });
    await execFileAsync("git", ["add", "package.json"], { cwd: project });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: project });
    await mkdir(path.join(project, "src"));
    await writeFile(
      path.join(project, "src", "new-payment.ts"),
      "export const intent = stripe.payment_intents.create;\n",
    );

    const result = await scanProjectChanges(project, { allowedRoots: [project] });

    expect(result.findings.payment.confidence).toBe("high");
    expect(result.findings.payment.evidence).toContainEqual(expect.objectContaining({
      source: "git_diff",
      location: "src/new-payment.ts",
      marker: "payment-provider-integration",
    }));
  });

  it("ignores added-looking text without a complete unified diff section", async () => {
    const project = await projectDirectory();
    const result = await scanProjectChanges(project, {
      allowedRoots: [project],
      diff: "+++ b/src/billing.ts\n+stripe.payment_intents\n",
    });

    expect(result.findings.payment.evidence).toEqual([]);
    expect(result.findings.payment.requiresReassessment).toBe(false);
    expect(result.requiresReassessment).toBe(false);
  });

  it.each<[FoundationSignal, string]>([
    ["payment", "const provider = stripe.payment_intents;"],
    ["multitenancy", "ALTER TABLE records ADD COLUMN tenant_id uuid;"],
    ["offline", "navigator.serviceWorker.register('/service-worker.js');"],
    ["sensitive_data", "store protected health information for patients"],
  ])("detects explicit %s evidence with high confidence", async (signal, addedLine) => {
    const project = await projectDirectory();
    const result = await scanProjectChanges(project, {
      allowedRoots: [project],
      diff: diffFor("src/change.ts", addedLine),
    });

    expect(result.findings[signal].confidence).toBe("high");
    expect(result.findings[signal].requiresReassessment).toBe(true);
    expect(result.affectedCapabilities).toContain(signal);
  });

  it("does not block on one ambiguous keyword", async () => {
    const project = await projectDirectory();
    const result = await scanProjectChanges(project, {
      allowedRoots: [project],
      diff: diffFor("src/theme.ts", "export const price = 'green';"),
    });

    expect(result.findings.payment.confidence).toBe("low");
    expect(result.findings.payment.requiresReassessment).toBe(false);
    expect(result.requiresReassessment).toBe(false);
  });

  it("requires two independent supporting sources when evidence is not explicit", async () => {
    const project = await projectDirectory();
    await mkdir(path.join(project, "src"));
    await writeFile(path.join(project, "src", "billing.ts"), "export const BILLING_MODE = 'manual';\n");
    const result = await scanProjectChanges(project, {
      allowedRoots: [project],
      diff: diffFor("src/account.ts", "export const billing = 'invoice';"),
    });

    expect(result.findings.payment.confidence).toBe("high");
    expect(new Set(result.findings.payment.evidence.map((entry) => entry.source)).size).toBeGreaterThanOrEqual(2);
  });

  it("excludes secrets and build directories from scanning", async () => {
    const project = await projectDirectory();
    await mkdir(path.join(project, "dist"));
    await writeFile(path.join(project, "dist", "tenant_id.sql"), "stripe payment_intents protected health information");
    await writeFile(path.join(project, ".env"), "STRIPE_SECRET_KEY=do-not-read\n");
    const result = await scanProjectChanges(project, { allowedRoots: [project], diff: "" });

    expect(result.requiresReassessment).toBe(false);
  });
});
