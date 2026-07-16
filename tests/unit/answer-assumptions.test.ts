import { describe, expect, it } from "vitest";

import { ModelAnalysisSchema } from "../../src/schemas.js";
import { analysis, fact, route } from "../helpers/model-fixtures.js";

describe("route fact assumption contract", () => {
  it("requires every route to bind a decision-changing unknown fact", () => {
    const input = analysis([route("managed_online")], { facts: [fact()] });
    const invalid = {
      ...input,
      candidate_routes: input.candidate_routes.map((candidate) => ({
        ...candidate,
        fact_assumptions: [],
      })),
    };

    expect(ModelAnalysisSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects a connected route that lies about the known offline-question assumption", () => {
    const input = analysis([route("managed_online")], { facts: [fact()] });
    const invalid = {
      ...input,
      candidate_routes: input.candidate_routes.map((candidate) => ({
        ...candidate,
        fact_assumptions: [{
          fact_key: "operations.offline_continuity",
          assumed_value: false,
        }],
      })),
    };

    const result = ModelAnalysisSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join("\n")).toContain(
        "continuously connected route",
      );
    }
  });
});
