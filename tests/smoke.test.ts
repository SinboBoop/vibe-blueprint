import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../src/constants.js";

describe("package skeleton", () => {
  it("declares the complete MCP tool surface", () => {
    expect(TOOL_NAMES).toHaveLength(8);
  });
});
