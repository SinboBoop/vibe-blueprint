export const BRAND_NAME = "Vibe Blueprint";
export const CLI_NAME = "vibe-blueprint";
export const PACKAGE_NAME = "vibe-blueprint-mcp";
export const PACKAGE_VERSION = "0.2.0";
export const FOUNDATION_SCHEMA_VERSION = 1;

export const DEFAULT_LLM_CONFIG = Object.freeze({
  baseUrl: "https://api.inferenvoy.com",
  model: "gpt-5.6-sol",
  reasoningEffort: "xhigh",
  codeSharing: "none" as const,
});

export const TOOL_NAMES = Object.freeze([
  "foundation_doctor",
  "foundation_analyze_project",
  "foundation_answer_question",
  "foundation_commit",
  "foundation_get",
  "foundation_assess_change",
  "foundation_scan_changes",
  "foundation_verify",
] as const);

export type ToolName = (typeof TOOL_NAMES)[number];
