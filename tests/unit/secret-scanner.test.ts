import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scannerPath = path.resolve("scripts/scan-secrets.mjs");

async function scan(content: string): Promise<{ readonly code: number; readonly output: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "foundation-secret-scan-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await writeFile(path.join(root, "candidate.txt"), content, "utf8");
  try {
    const result = await execFileAsync(process.execPath, [scannerPath], { cwd: root });
    return { code: 0, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    const result = error as { readonly code: number; readonly stdout: string; readonly stderr: string };
    return { code: result.code, output: `${result.stdout}${result.stderr}` };
  }
}

describe("repository secret scanner", () => {
  it.each([
    ["FOUNDATION_LLM_API", "KEY=inferenvoyOpaqueToken1234567890"].join("_"),
    `{${["api", "key"].join("_")}:"opaqueProviderToken1234567890"}`,
    `//registry.example/:${["_auth", "Token"].join("")}=npm_opaqueProviderToken1234567890`,
    ["FOUNDATION_LLM_API", "KEY=not-really-placeholder-but-secret-1234567890"].join("_"),
    `${["FOUNDATION_LLM_API", "KEY"].join("_")}=${["b3BhcXVl", "YmFzZTY0", "dG9rZW4="].join("")}=`,
    `{${["api", "key"].join("_")}:"opaque:relay/base64+segment=="}`,
    `//registry.example/:${["_auth", "Token"].join("")}=opaque:registry/token+value==`,
  ])("rejects a high-confidence credential assignment without echoing its value", async (content) => {
    const result = await scan(content);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/^Possible credential material found at \d+ location\(s\)\.\n$/u);
  });

  it("allows only the exact documented placeholder", async () => {
    const result = await scan(
      `${["FOUNDATION_LLM_API", "KEY"].join("_")}=replace-with-your-own-key\n`,
    );
    expect(result.code).toBe(0);
  });

  it("ignores a tracked file deleted from the working tree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "foundation-secret-scan-deleted-"));
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    const deletedPath = path.join(root, "renamed-away.md");
    await writeFile(deletedPath, "no credential material\n", "utf8");
    await execFileAsync("git", ["add", "renamed-away.md"], { cwd: root });
    await rm(deletedPath);

    const result = await execFileAsync(process.execPath, [scannerPath], { cwd: root });
    expect(`${result.stdout}${result.stderr}`).toMatch(/^Secret scan passed \(0 files;/u);
  });

  it("does not mistake a variable reference for literal credential material", async () => {
    const result = await scan(
      `${["FOUNDATION_LLM_API", "KEY"].join("_")} = previousApiKey;\n`,
    );
    expect(result.code).toBe(0);
  });

  it.each([
    `${["FOUNDATION_LLM_API", "KEY"].join("_")} = previousApiKey;`,
    `const ${["api", "key"].join("_")} = encode(value + "=");`,
    `const ${["api", "key"].join("_")}: string = previousApiKey;`,
    "const comparison = left === right ? before : after;",
  ])("does not mistake ordinary code for a literal credential assignment", async (content) => {
    const result = await scan(`${content}\n`);
    expect(result.code).toBe(0);
  });
});
