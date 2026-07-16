import { describe, expect, it } from "vitest";

import { sanitizeProjectSummary, sanitizeRepositoryDiff } from "../../src/model-context.js";

describe("model-bound repository context", () => {
  it("drops sensitive and dependency diff sections and redacts tokens", () => {
    const diff = `diff --git a/.env b/.env
--- a/.env
+++ b/.env
@@ -0,0 +1 @@
+FOUNDATION_LLM_API_KEY=sk-secretvalue
diff --git a/node_modules/pkg/index.js b/node_modules/pkg/index.js
--- a/node_modules/pkg/index.js
+++ b/node_modules/pkg/index.js
@@ -0,0 +1 @@
+payment provider
diff --git a/src/billing.ts b/src/billing.ts
--- a/src/billing.ts
+++ b/src/billing.ts
@@ -0,0 +1,2 @@
+const authorization = "Bearer abcdefghijk";
+stripe checkout`;
    const result = sanitizeRepositoryDiff(diff);
    expect(result).toContain("FILE: src/billing.ts");
    expect(result).toContain("stripe checkout");
    expect(result).not.toContain(".env");
    expect(result).not.toContain("node_modules");
    expect(result).not.toContain("abcdefghijk");
  });

  it.each([
    [".npmrc", "//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz123456"],
    [".netrc", "machine example.test login user password opaque-password"],
    [".pypirc", "password = opaque-package-password"],
    [".docker/config.json", '{"auths":{"registry.example":{"auth":"opaque-docker-auth"}}}'],
    [".aws/credentials", "aws_access_key_id = AKIAIOSFODNN7EXAMPLE"],
  ])("drops the common credential file %s in diff-sharing mode", (file, secretLine) => {
    const diff = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+${secretLine}\ndiff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -0,0 +1 @@\n+safe documentation`;
    const result = sanitizeRepositoryDiff(diff);
    expect(result).toContain("safe documentation");
    expect(result).not.toContain(file);
    expect(result).not.toContain(secretLine);
  });

  it("does not let an added +++ line escape a sensitive-file hunk", () => {
    const secret = "opaque-sensitive-value-9f731bc";
    const diff = `diff --git a/.env b/.env
--- a/.env
+++ b/.env
@@ -0,0 +1,2 @@
+++ b/README.md
+${secret}
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -0,0 +1 @@
+safe documentation`;

    const result = sanitizeRepositoryDiff(diff);
    expect(result).toContain("FILE: README.md");
    expect(result).toContain("safe documentation");
    expect(result).not.toContain(secret);
    expect(result).not.toContain(".env");
  });

  it("rejects a source-code dump disguised as a summary", () => {
    const source = Array.from({ length: 10 }, (_, index) => `export const item${index} = () => { return ${index}; };`).join("\n");
    expect(() => sanitizeProjectSummary(source)).toThrow(/source code/u);
  });

  it.each([
    ["Python", Array.from({ length: 10 }, (_, index) => `def item_${index}(value):\n    return value + ${index}`).join("\n")],
    ["Go", `package billing\n\nimport "context"\n\nfunc CreateCharge(ctx context.Context) error {\n  return nil\n}\n\nfunc Refund(ctx context.Context) error {\n  return nil\n}`],
    ["Java", `public final class BillingService {\n  private final Client client;\n  public BillingService(Client client) {\n    this.client = client;\n  }\n  public void charge() {\n    client.charge();\n  }\n}`],
    ["Rust", `use crate::client::Client;\n\npub struct Billing {\n    client: Client,\n}\n\nimpl Billing {\n    pub fn charge(&self) {\n        self.client.charge();\n    }\n}`],
  ])("rejects a %s source dump disguised as a summary", (_language, source) => {
    expect(() => sanitizeProjectSummary(source)).toThrow(/source code/u);
  });

  it("accepts a concise structural summary", () => {
    const summary = "Browser client, one HTTP service, PostgreSQL, and a background worker.\nModules: accounts, projects, reporting.\nDeployment: managed application platform.";
    expect(sanitizeProjectSummary(summary)).toBe(summary);
  });
});
