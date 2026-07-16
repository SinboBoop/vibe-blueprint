import { describe, expect, it } from "vitest";

import { ModelAnalysisSchema, ProposedStackSchema } from "../../src/schemas.js";
import { findUnsupportedTechnologyClaims } from "../../src/technology-claims.js";
import { analysis, route } from "../helpers/model-fixtures.js";

describe("technology claim boundary", () => {
  it("accepts compatibility ranges, latest-stable wording, and honest limitations", () => {
    const candidate = route("managed_online", {
      proposed_stack: {
        ...route("base").proposed_stack,
        client: {
          ...route("base").proposed_stack.client,
          choice: "React >=19 compatible range, resolved to the latest stable release at install time",
          limitation: "It does not guarantee zero downtime or 100% compliance; capacity remains limited.",
        },
      },
    });

    expect(ModelAnalysisSchema.safeParse(analysis([candidate])).success).toBe(true);
  });

  it.each([
    ["React 19.1.0", "unverified_exact_version"],
    ["Managed hosting at $20/month", "unverified_specific_price"],
    ["A free tier for every deployment", "unverified_specific_price"],
    ["Unlimited storage with zero downtime and 100% compliance", "unverifiable_absolute_capability"],
    ["每月 99 元，无限存储且零故障", "unverified_specific_price"],
  ])("rejects unsupported model-authored claim %j", (choice, expectedKind) => {
    const stack = route("base").proposed_stack;
    const result = ProposedStackSchema.safeParse({
      ...stack,
      deployment: { ...stack.deployment, choice },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join("\n")).toContain(expectedKind);
    }
  });

  it("reports all claim categories without treating a negated warning as a claim", () => {
    expect(findUnsupportedTechnologyClaims(
      "VendorDB v3.4 costs 10 USD per month and promises unlimited capacity.",
    ).map((finding) => finding.kind)).toEqual(expect.arrayContaining([
      "unverified_exact_version",
      "unverified_specific_price",
      "unverifiable_absolute_capability",
    ]));
    expect(findUnsupportedTechnologyClaims(
      "This does not promise unlimited capacity and cannot guarantee zero downtime.",
    )).toEqual([]);
  });

  it("does not mistake UI elements or a latency target for a price or version", () => {
    expect(findUnsupportedTechnologyClaims("可访问的 UI 元素和清晰的交互状态。")).toEqual([]);
    expect(findUnsupportedTechnologyClaims("The product target is a response within 2.5 seconds.")).toEqual([]);
  });
});
