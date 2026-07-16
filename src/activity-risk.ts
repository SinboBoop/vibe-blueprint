import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { redactSensitiveText } from "./security.js";
import type { FoundationFact, RiskState } from "./schemas.js";

export const ACTIVITY_RULE_IDS = [
  "expense_workflow",
  "financial_records",
  "money_movement",
  "credit_decision",
  "investment_advice",
  "critical_security",
  "critical_privacy",
] as const;

export const ACTIVITY_ACTIONS = [
  "normal",
  "safeguards_required",
  "confirm_scope",
  "specialist_review",
] as const;

export const ActivityRuleIdSchema = z.enum(ACTIVITY_RULE_IDS);
export const ActivityActionSchema = z.enum(ACTIVITY_ACTIONS);
export const ActivityEvidenceSourceSchema = z.enum(["requirement", "fact", "risk"]);

const SignalTermsSchema = z
  .object({
    en: z.array(z.string().trim().min(2).max(120)).min(1).max(40),
    zh: z.array(z.string().trim().min(1).max(120)).min(1).max(40),
  })
  .strict();

const SignalGroupSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    terms: SignalTermsSchema,
  })
  .strict();

const ActivityRuleSchema = z
  .object({
    id: ActivityRuleIdSchema,
    primary_activity: ActivityRuleIdSchema,
    action: ActivityActionSchema,
    minimum_independent_signals: z.number().int().min(1).max(10),
    positive_signal_groups: z.array(SignalGroupSchema).min(1).max(10),
    negative_signal_groups: z.array(SignalGroupSchema).min(1).max(10),
  })
  .strict();

export const ActivityRiskRulesDocumentSchema = z
  .object({
    schema_version: z.literal(1),
    scope_confirmation: z
      .object({
        rule_id: z.literal("financial_activity_scope"),
        question_key: z.literal("financial_activity_scope"),
        signal_terms: SignalTermsSchema,
      })
      .strict(),
    rules: z.array(ActivityRuleSchema).length(ACTIVITY_RULE_IDS.length),
  })
  .strict();

export const ActivityEvidenceSchema = z
  .object({
    rule_id: z.string().min(1).max(96),
    source: ActivityEvidenceSourceSchema,
    signal_group: z.string().min(1).max(96),
    excerpt: z.string().min(1).max(300),
    negated: z.boolean(),
  })
  .strict();

export const ActivityClassificationSchema = z
  .object({
    rules_version: z.literal(1),
    primary_activity: ActivityRuleIdSchema.nullable(),
    action: ActivityActionSchema,
    scope_question_key: z.literal("financial_activity_scope").nullable(),
    matched_rule_ids: z.array(z.string().min(1).max(96)).max(8),
    evidence: z.array(ActivityEvidenceSchema).max(100),
  })
  .strict();

export type ActivityRuleId = z.infer<typeof ActivityRuleIdSchema>;
export type ActivityAction = z.infer<typeof ActivityActionSchema>;
export type ActivityEvidence = z.infer<typeof ActivityEvidenceSchema>;
export type ActivityClassification = z.infer<typeof ActivityClassificationSchema>;
type MutableActivityRiskRules = z.infer<typeof ActivityRiskRulesDocumentSchema>;
type DeepReadonly<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

export type ActivityRiskRules = DeepReadonly<MutableActivityRiskRules>;

export type RiskRulesFailureReason =
  | "missing_resource"
  | "unreadable_resource"
  | "corrupt_json"
  | "unsupported_schema_version"
  | "duplicate_identifier"
  | "invalid_rules";

export class RiskRulesInvalidError extends Error {
  override readonly name = "RiskRulesInvalidError";
  readonly reason: RiskRulesFailureReason;
  readonly source: string;

  constructor(reason: RiskRulesFailureReason, source: string, detail: string) {
    super(`Activity risk rules ${reason.replaceAll("_", " ")} (${source}): ${detail}`);
    this.reason = reason;
    this.source = source;
  }
}

export interface LoadActivityRiskRulesOptions {
  readonly resourcePath?: string;
}

export const DEFAULT_ACTIVITY_RISK_RULES_PATH = fileURLToPath(
  new URL("../resources/activity-risk-rules.json", import.meta.url),
);

const rulesCache = new Map<string, ActivityRiskRules>();

function deepFreeze<Value>(value: Value): DeepReadonly<Value> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<Value>;
}

function duplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

function assertUnique(values: readonly string[], label: string, source: string): void {
  const repeated = duplicate(values);
  if (repeated !== undefined) {
    throw new RiskRulesInvalidError(
      "duplicate_identifier",
      source,
      `${label} contains duplicate identifier ${repeated}.`,
    );
  }
}

function formattedIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function hasSchemaVersion(input: unknown): input is { readonly schema_version: unknown } {
  return input !== null &&
    typeof input === "object" &&
    Object.prototype.hasOwnProperty.call(input, "schema_version");
}

function normalizedSignalTerm(term: string): string {
  return normalizeText(term);
}

export function validateActivityRiskRules(
  input: unknown,
  source = "<memory>",
): ActivityRiskRules {
  if (hasSchemaVersion(input) && input.schema_version !== 1) {
    throw new RiskRulesInvalidError(
      "unsupported_schema_version",
      source,
      "Only activity risk rules schema_version 1 is supported.",
    );
  }
  const parsed = ActivityRiskRulesDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new RiskRulesInvalidError("invalid_rules", source, formattedIssues(parsed.error));
  }
  const rules = parsed.data;
  assertUnique(rules.rules.map((rule) => rule.id), "rules", source);

  const actualIds = new Set(rules.rules.map((rule) => rule.id));
  const missing = ACTIVITY_RULE_IDS.filter((id) => !actualIds.has(id));
  if (missing.length > 0) {
    throw new RiskRulesInvalidError(
      "invalid_rules",
      source,
      `rules are missing the reviewed activity identifiers: ${missing.join(", ")}.`,
    );
  }

  for (const rule of rules.rules) {
    if (rule.primary_activity !== rule.id) {
      throw new RiskRulesInvalidError(
        "invalid_rules",
        source,
        `${rule.id}.primary_activity must equal its fixed rule identifier.`,
      );
    }
    if (rule.minimum_independent_signals > rule.positive_signal_groups.length) {
      throw new RiskRulesInvalidError(
        "invalid_rules",
        source,
        `${rule.id}.minimum_independent_signals exceeds its positive signal-group count.`,
      );
    }
    if (rule.action !== EXPECTED_ACTION_BY_RULE[rule.id]) {
      throw new RiskRulesInvalidError(
        "invalid_rules",
        source,
        `${rule.id}.action must be ${EXPECTED_ACTION_BY_RULE[rule.id]} in the fixed activity vocabulary.`,
      );
    }
    const groups = [...rule.positive_signal_groups, ...rule.negative_signal_groups];
    assertUnique(groups.map((group) => group.id), `${rule.id} signal groups`, source);
    for (const group of groups) {
      assertUnique(
        [...group.terms.en, ...group.terms.zh].map(normalizedSignalTerm),
        `${rule.id}.${group.id} terms`,
        source,
      );
    }

    const positiveTerms = new Set(
      rule.positive_signal_groups.flatMap((group) =>
        [...group.terms.en, ...group.terms.zh].map(normalizedSignalTerm)
      ),
    );
    const negativeTerms = new Set(
      rule.negative_signal_groups.flatMap((group) =>
        [...group.terms.en, ...group.terms.zh].map(normalizedSignalTerm)
      ),
    );
    const contradictoryTerms = [...positiveTerms]
      .filter((term) => negativeTerms.has(term))
      .sort((left, right) => left.localeCompare(right));
    if (contradictoryTerms.length > 0) {
      throw new RiskRulesInvalidError(
        "invalid_rules",
        source,
        `${rule.id} contains terms in both positive and negative signal groups after normalization: ${contradictoryTerms.join(", ")}.`,
      );
    }
  }

  return deepFreeze(rules);
}

function readAndValidateRules(resourcePath: string): ActivityRiskRules {
  let raw: string;
  try {
    raw = readFileSync(resourcePath, "utf8");
  } catch (error: unknown) {
    const code = error !== null && typeof error === "object" && "code" in error
      ? String(error.code)
      : undefined;
    throw new RiskRulesInvalidError(
      code === "ENOENT" ? "missing_resource" : "unreadable_resource",
      resourcePath,
      code === "ENOENT" ? "The packaged resource file was not found." : "The packaged resource could not be read.",
    );
  }

  let input: unknown;
  try {
    input = JSON.parse(raw) as unknown;
  } catch {
    throw new RiskRulesInvalidError(
      "corrupt_json",
      resourcePath,
      "The packaged resource is not valid JSON.",
    );
  }
  return validateActivityRiskRules(input, resourcePath);
}

export function loadActivityRiskRules(
  options: LoadActivityRiskRulesOptions = {},
): ActivityRiskRules {
  const resourcePath = path.resolve(options.resourcePath ?? DEFAULT_ACTIVITY_RISK_RULES_PATH);
  const cached = rulesCache.get(resourcePath);
  if (cached !== undefined) return cached;
  const rules = readAndValidateRules(resourcePath);
  rulesCache.set(resourcePath, rules);
  return rules;
}

export interface ClassifyActivityRiskInput {
  readonly requirement: string;
  readonly facts: readonly FoundationFact[];
  readonly riskState: RiskState;
}

export interface ClassifyActivityRiskOptions {
  readonly rules?: ActivityRiskRules;
}

interface EvidenceSourceText {
  readonly source: ActivityEvidence["source"];
  readonly text: string;
  readonly forceNegated: boolean;
  readonly unknownScope: boolean;
}

const UNKNOWN_ACTIVITY_SCOPE = /(?:\b(?:not (?:yet )?(?:decided|determined|known|clear|confirmed|sure)|still (?:unknown|unclear|undecided)|uncertain|undecided|to be determined|tbd)\b|尚未确定|还没确定|仍未确定|不确定|尚不清楚|还不清楚|待确定|是(?:否|只).*还是|还是会)/iu;

interface TermMatch {
  readonly start: number;
  readonly end: number;
  readonly term: string;
}

interface EvaluatedRule {
  readonly id: ActivityRuleId;
  readonly action: ActivityAction;
  readonly matched: boolean;
  readonly conflicted: boolean;
  readonly evidence: readonly ActivityEvidence[];
}

const MATERIAL_FINANCIAL_ACTIVITY_IDS = new Set<ActivityRuleId>([
  "money_movement",
  "credit_decision",
  "investment_advice",
]);

const ACTIVITY_PRIORITY: readonly ActivityRuleId[] = [
  "critical_security",
  "critical_privacy",
  "money_movement",
  "credit_decision",
  "investment_advice",
  "financial_records",
  "expense_workflow",
];

const EXPECTED_ACTION_BY_RULE: Readonly<Record<ActivityRuleId, ActivityAction>> = {
  expense_workflow: "normal",
  financial_records: "safeguards_required",
  money_movement: "specialist_review",
  credit_decision: "specialist_review",
  investment_advice: "specialist_review",
  critical_security: "specialist_review",
  critical_privacy: "specialist_review",
};

function normalizeText(value: string): string {
  return redactSensitiveText(value)
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\t\r\n]+/gu, " ")
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .replaceAll("[redacted]", "[REDACTED]")
    .trim();
}

function factText(fact: FoundationFact): string {
  const value = typeof fact.value === "string"
    ? fact.value
    : fact.value === null
      ? ""
      : String(fact.value);
  return [fact.key, fact.label, value, fact.source_excerpt ?? ""]
    .filter((part) => part.length > 0)
    .join(". ");
}

function evidenceSources(input: ClassifyActivityRiskInput): readonly EvidenceSourceText[] {
  const sources: EvidenceSourceText[] = [{
    source: "requirement",
    text: input.requirement,
    forceNegated: false,
    unknownScope: false,
  }];
  for (const fact of input.facts) {
    const text = factText(fact);
    if (text.trim().length === 0) continue;
    sources.push({
      source: "fact",
      text,
      forceNegated: fact.value === false,
      unknownScope: fact.value === null || fact.certainty === "unknown_critical",
    });
  }
  for (const assessment of input.riskState.domains) {
    sources.push({
      source: "risk",
      text: assessment.reason,
      forceNegated: false,
      unknownScope: false,
    });
  }
  for (const reason of input.riskState.reasons) {
    sources.push({
      source: "risk",
      text: reason,
      forceNegated: false,
      unknownScope: false,
    });
  }
  return sources;
}

function isAsciiWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[a-z0-9]/u.test(character);
}

function findTermMatches(text: string, term: string): readonly TermMatch[] {
  const normalizedTerm = normalizeText(term);
  if (normalizedTerm.length === 0) return [];
  const asciiBoundaries = /^[a-z0-9 ]+$/u.test(normalizedTerm);
  const matches: TermMatch[] = [];
  let offset = 0;
  while (offset <= text.length - normalizedTerm.length) {
    const start = text.indexOf(normalizedTerm, offset);
    if (start === -1) break;
    const end = start + normalizedTerm.length;
    if (
      !asciiBoundaries ||
      (!isAsciiWordCharacter(text[start - 1]) && !isAsciiWordCharacter(text[end]))
    ) {
      matches.push({ start, end, term: normalizedTerm });
    }
    offset = Math.max(start + 1, end);
  }
  return matches;
}

function spansOverlap(left: TermMatch, right: TermMatch): boolean {
  return left.start < right.end && right.start < left.end;
}

function locallyNegated(text: string, match: TermMatch): boolean {
  const prefix = text.slice(Math.max(0, match.start - 36), match.start);
  if (/(?:\b(?:does not|do not|did not|will not|must not|cannot|can't|won't|never|without|no)\s+(?:\w+\s+){0,3}|(?:不|不会|不能|不得|禁止|无需|没有|未)[^，。；,.!?！？]{0,12})$/u.test(prefix)) {
    return true;
  }

  const clausePrefix = text.slice(Math.max(0, match.start - 96), match.start);
  if (/(?:\b(?:but|however|instead|yet)\b|但是|但|而是|却)[^.!?。！？；;]*$/u.test(clausePrefix)) {
    return false;
  }
  return /(?:\b(?:does not|do not|did not|will not|must not|cannot|can't|won't|never)\b[^.!?;]{0,72}(?:,|\bor\b|\band\b)\s*|(?:不|不会|不能|不得|禁止|无需|没有|未)[^。！？；;]{0,40}(?:、|，|或|也|并)\s*)$/u.test(clausePrefix);
}

function evidenceExcerpt(text: string, match: TermMatch): string {
  const start = Math.max(0, match.start - 80);
  const end = Math.min(text.length, match.end + 80);
  return redactSensitiveText(text.slice(start, end)).slice(0, 300);
}

function matchesForTerms(
  text: string,
  terms: { readonly en: readonly string[]; readonly zh: readonly string[] },
): readonly TermMatch[] {
  return [...terms.en, ...terms.zh]
    .flatMap((term) => findTermMatches(text, term))
    .sort((left, right) => left.start - right.start || right.end - left.end || left.term.localeCompare(right.term));
}

function uniqueEvidence(evidence: readonly ActivityEvidence[]): readonly ActivityEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.rule_id}\u0000${item.source}\u0000${item.signal_group}\u0000${item.excerpt}\u0000${String(item.negated)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface ReviewedSignalPair {
  readonly actionGroup: string;
  readonly objectGroup: string;
}

const REVIEWED_SIGNAL_PAIRS: Readonly<Partial<Record<ActivityRuleId, ReviewedSignalPair>>> = {
  financial_records: {
    actionGroup: "record_handling_action",
    objectGroup: "financial_record_artifact",
  },
  money_movement: {
    actionGroup: "funds_control_action",
    objectGroup: "funds_object",
  },
  credit_decision: {
    actionGroup: "credit_decision_action",
    objectGroup: "credit_subject",
  },
  investment_advice: {
    actionGroup: "investment_recommendation_action",
    objectGroup: "investment_subject",
  },
  critical_security: {
    actionGroup: "critical_security_action",
    objectGroup: "security_control_or_secret",
  },
  critical_privacy: {
    actionGroup: "critical_privacy_action",
    objectGroup: "sensitive_personal_data",
  },
};

const CLAUSE_BOUNDARY = /(?:[.!?;。！？；]|\b(?:but|however|whereas|instead)\b|但是|但|而是|却)/u;
const UNRELATED_GAP = /(?:\b(?:profile|account settings?|history|records?|reports?|glossary|words?|page|screen|metadata|analytics|display|show|view|read|store|archive|using|based on)\b|资料访问|账户设置|历史|记录|报告|词汇表|页面|展示|查看|读取|存储|归档)/u;

function objectHasNonActivityContext(
  ruleId: ActivityRuleId,
  text: string,
  objectMatch: TermMatch,
): boolean {
  const suffix = text.slice(objectMatch.end, objectMatch.end + 32);
  if (ruleId === "money_movement") {
    return /^\s+(?:history|records?|logs?|reports?|status|data|profile|methods?)(?:\b|$)/u.test(suffix);
  }
  if (ruleId === "credit_decision") {
    return /^\s+(?:history|records?|reports?|data)(?:\b|$)/u.test(suffix);
  }
  if (ruleId === "investment_advice") {
    return /^\s+(?:history|records?|reports?|data)(?:\b|$)/u.test(suffix);
  }
  return false;
}

function signalsDescribeOneActivity(
  ruleId: ActivityRuleId,
  text: string,
  actionMatch: TermMatch,
  objectMatch: TermMatch,
): boolean {
  if (objectHasNonActivityContext(ruleId, text, objectMatch)) return false;
  if (spansOverlap(actionMatch, objectMatch)) return true;

  if (actionMatch.end > objectMatch.start) {
    const passiveGap = text.slice(objectMatch.end, actionMatch.start);
    if (passiveGap.length > 48 || CLAUSE_BOUNDARY.test(passiveGap) || UNRELATED_GAP.test(passiveGap)) {
      return false;
    }
    return /^\s*(?:(?:is|are|was|were|will|can|must|only|just|be|being|for|of|unauthorized|bulk|automated)\s+){0,5}$/u.test(passiveGap);
  }

  const gap = text.slice(actionMatch.end, objectMatch.start);
  if (gap.length > 72 || CLAUSE_BOUNDARY.test(gap) || UNRELATED_GAP.test(gap)) return false;
  const englishWords = gap.match(/[a-z0-9]+/gu) ?? [];
  const chineseCharacters = gap.match(/[\p{Script=Han}]/gu) ?? [];
  return englishWords.length <= 8 && chineseCharacters.length <= 24;
}

function supportedPositiveGroups(
  ruleId: ActivityRuleId,
  text: string,
  matchesByGroup: ReadonlyMap<string, readonly TermMatch[]>,
): ReadonlySet<string> {
  const pair = REVIEWED_SIGNAL_PAIRS[ruleId];
  if (pair === undefined) return new Set(matchesByGroup.keys());
  const actions = matchesByGroup.get(pair.actionGroup) ?? [];
  const objects = matchesByGroup.get(pair.objectGroup) ?? [];
  const supported = actions.some((actionMatch) =>
    objects.some((objectMatch) =>
      signalsDescribeOneActivity(ruleId, text, actionMatch, objectMatch)
    )
  );
  return supported
    ? new Set([pair.actionGroup, pair.objectGroup])
    : new Set();
}

function evaluateRule(
  rule: ActivityRiskRules["rules"][number],
  sources: readonly EvidenceSourceText[],
): EvaluatedRule {
  const evidence: ActivityEvidence[] = [];
  const positiveGroups = new Set<string>();
  let hasExplicitNegative = false;

  for (const source of sources) {
    const text = normalizeText(source.text);
    if (text.length === 0) continue;
    const sourceScopeUnknown = source.unknownScope || UNKNOWN_ACTIVITY_SCOPE.test(text);
    const unnegatedMatchesByGroup = new Map<string, TermMatch[]>();
    const negativeMatches = rule.negative_signal_groups.flatMap((group) =>
      matchesForTerms(text, group.terms).map((match) => ({ group, match })),
    );
    if (negativeMatches.length > 0) hasExplicitNegative = true;
    for (const { group, match } of negativeMatches) {
      evidence.push({
        rule_id: rule.id,
        source: source.source,
        signal_group: group.id,
        excerpt: evidenceExcerpt(text, match),
        negated: true,
      });
    }

    if (sourceScopeUnknown) continue;
    for (const group of rule.positive_signal_groups) {
      const matches = matchesForTerms(text, group.terms);
      for (const match of matches) {
        const negated = source.forceNegated ||
          locallyNegated(text, match) ||
          negativeMatches.some((negative) => spansOverlap(match, negative.match));
        evidence.push({
          rule_id: rule.id,
          source: source.source,
          signal_group: group.id,
          excerpt: evidenceExcerpt(text, match),
          negated,
        });
        if (!negated) {
          const groupMatches = unnegatedMatchesByGroup.get(group.id) ?? [];
          groupMatches.push(match);
          unnegatedMatchesByGroup.set(group.id, groupMatches);
        }
      }
    }
    for (const groupId of supportedPositiveGroups(rule.id, text, unnegatedMatchesByGroup)) {
      positiveGroups.add(groupId);
    }
  }

  const matched = positiveGroups.size >= rule.minimum_independent_signals;
  return {
    id: rule.id,
    action: rule.action,
    matched,
    conflicted: matched && hasExplicitNegative,
    evidence: uniqueEvidence(evidence),
  };
}

function criticalRiskEvidence(
  ruleId: "critical_security" | "critical_privacy",
  input: ClassifyActivityRiskInput,
): ActivityEvidence | undefined {
  const domain = ruleId === "critical_security" ? "security" : "privacy";
  const assessment = input.riskState.domains.find((candidate) =>
    candidate.domain === domain &&
    candidate.severity === "critical" &&
    candidate.requires_escalation,
  );
  if (assessment === undefined) return undefined;
  return {
    rule_id: ruleId,
    source: "risk",
    signal_group: "validated_critical_assessment",
    excerpt: redactSensitiveText(assessment.reason).slice(0, 300),
    negated: false,
  };
}

function scopeEvidence(
  rules: ActivityRiskRules,
  sources: readonly EvidenceSourceText[],
): readonly ActivityEvidence[] {
  const evidence: ActivityEvidence[] = [];
  for (const source of sources) {
    const text = normalizeText(source.text);
    for (const match of matchesForTerms(text, rules.scope_confirmation.signal_terms)) {
      const negated = source.forceNegated || locallyNegated(text, match);
      evidence.push({
        rule_id: rules.scope_confirmation.rule_id,
        source: source.source,
        signal_group: "broad_financial_scope",
        excerpt: evidenceExcerpt(text, match),
        negated,
      });
    }
  }
  return uniqueEvidence(evidence);
}

function classification(
  primaryActivity: ActivityRuleId | null,
  action: ActivityAction,
  matchedRuleIds: readonly string[],
  evidence: readonly ActivityEvidence[],
  scopeQuestionKey: "financial_activity_scope" | null = null,
): ActivityClassification {
  return ActivityClassificationSchema.parse({
    rules_version: 1,
    primary_activity: primaryActivity,
    action,
    scope_question_key: scopeQuestionKey,
    matched_rule_ids: [...new Set(matchedRuleIds)],
    evidence: uniqueEvidence(evidence).slice(0, 100),
  });
}

export function classifyActivityRisk(
  input: ClassifyActivityRiskInput,
  options: ClassifyActivityRiskOptions = {},
): ActivityClassification {
  const rules = options.rules ?? loadActivityRiskRules();
  const sources = evidenceSources(input);
  const evaluated = rules.rules.map((rule) => evaluateRule(rule, sources));

  for (const ruleId of ["critical_security", "critical_privacy"] as const) {
    const directEvidence = criticalRiskEvidence(ruleId, input);
    if (directEvidence === undefined) continue;
    const rule = evaluated.find((candidate) => candidate.id === ruleId);
    const evidence = rule === undefined ? [directEvidence] : [...rule.evidence, directEvidence];
    const otherMatched = evaluated.filter((candidate) => candidate.matched).map((candidate) => candidate.id);
    return classification(
      ruleId,
      "specialist_review",
      [ruleId, ...otherMatched],
      uniqueEvidence(evidence),
    );
  }

  const matched = evaluated.filter((rule) => rule.matched);
  const financialConflict = matched.find((rule) =>
    MATERIAL_FINANCIAL_ACTIVITY_IDS.has(rule.id) && rule.conflicted,
  );
  if (financialConflict !== undefined) {
    return classification(
      null,
      "confirm_scope",
      [financialConflict.id, rules.scope_confirmation.rule_id],
      financialConflict.evidence,
      rules.scope_confirmation.question_key,
    );
  }

  const selectedId = ACTIVITY_PRIORITY.find((id) => matched.some((candidate) => candidate.id === id));
  if (selectedId !== undefined) {
    const selected = matched.find((candidate) => candidate.id === selectedId);
    if (selected === undefined) throw new Error(`Matched activity rule disappeared: ${selectedId}`);
    return classification(
      selected.id,
      selected.action,
      matched.map((candidate) => candidate.id),
      evaluated.flatMap((candidate) => candidate.evidence),
    );
  }

  const broadScopeEvidence = scopeEvidence(rules, sources).filter((item) => !item.negated);
  const unknownMaterialActivity = sources.some((source) => {
    const text = normalizeText(source.text);
    if (!UNKNOWN_ACTIVITY_SCOPE.test(text)) return false;
    return evaluated.some((rule) =>
      MATERIAL_FINANCIAL_ACTIVITY_IDS.has(rule.id) &&
      rule.evidence.some((item) => item.source === source.source)
    ) || /(?:\b(?:payment|payments|funds?|money|transfers?|credit|loan|investment)\b|支付|付款|资金|款项|转账|信贷|贷款|投资)/iu.test(text);
  });
  const unknownFinancialFact = input.facts.some((fact) =>
    (fact.value === null || fact.certainty === "unknown_critical") &&
    matchesForTerms(normalizeText(factText(fact)), rules.scope_confirmation.signal_terms).length > 0,
  );
  if (broadScopeEvidence.length > 0 || unknownFinancialFact || unknownMaterialActivity) {
    return classification(
      null,
      "confirm_scope",
      [rules.scope_confirmation.rule_id],
      broadScopeEvidence,
      rules.scope_confirmation.question_key,
    );
  }

  return classification(
    null,
    "normal",
    [],
    evaluated.flatMap((candidate) => candidate.evidence),
  );
}
