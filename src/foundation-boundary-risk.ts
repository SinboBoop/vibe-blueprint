import { redactSensitiveText } from "./security.js";
import type { FoundationFact, RiskDomainAssessment, RiskState } from "./schemas.js";

export const FOUNDATION_BOUNDARY_RISK_DOMAINS = [
  "medical",
  "children_data",
  "complex_compliance",
  "capability_boundary",
] as const;

export type FoundationBoundaryRiskDomain = typeof FOUNDATION_BOUNDARY_RISK_DOMAINS[number];

export interface DetectFoundationBoundaryRisksInput {
  readonly requirement: string;
  readonly facts: readonly FoundationFact[];
}

interface SignalMatch {
  readonly start: number;
  readonly end: number;
  readonly term: string;
}

interface BoundaryRule {
  readonly domain: FoundationBoundaryRiskDomain;
  readonly reason: string;
  readonly actions: readonly string[];
  readonly subjects: readonly string[];
  readonly exact?: readonly string[];
}

const RULES: readonly BoundaryRule[] = [
  {
    domain: "medical",
    reason: "The product makes clinical diagnosis or treatment recommendations and requires qualified clinical review.",
    actions: [
      "diagnose", "diagnoses", "diagnosing", "diagnosis", "diagnostic decision",
      "recommend treatment", "recommends treatment", "treatment recommendation", "prescribe", "prescribes",
      "select therapy", "selects therapy", "select medication", "selects medication", "medication dosage",
      "recommend care", "recommends care", "care pathway", "triage", "triages",
      "诊断", "辅助诊断", "治疗建议", "推荐治疗", "开处方", "处方建议",
      "选择疗法", "选择药物", "用药剂量", "推荐就医", "就医方案", "分诊",
    ],
    subjects: [
      "patient", "patients", "clinical", "medical", "disease", "condition", "symptom", "treatment", "medication",
      "患者", "病人", "临床", "医疗", "疾病", "病情", "症状", "治疗", "用药",
    ],
    exact: [
      "automated medical diagnosis", "automated clinical diagnosis",
      "自动医疗诊断", "自动临床诊断",
    ],
  },
  {
    domain: "children_data",
    reason: "The product stores or processes data that identifies children or minors and requires specialist child-data/privacy review.",
    actions: [
      "collect", "collects", "store", "stores", "process", "processes", "share", "shares",
      "track", "tracks", "profile", "profiles", "upload", "uploads", "record", "records",
      "retain", "retains", "analyze", "analyzes",
      "收集", "存储", "处理", "共享", "追踪", "画像", "上传", "记录", "保留", "分析",
    ],
    subjects: [
      "children's personal data", "children personal data", "child personal data", "child data", "children data",
      "minor personal data", "minors' personal data", "child location", "minor location",
      "children's date of birth", "children's dates of birth", "child date of birth", "minor date of birth",
      "school identifier", "school identifiers", "student identifier", "student identifiers",
      "儿童个人信息", "儿童个人数据", "儿童数据", "未成年人个人信息", "未成年人数据",
      "儿童位置", "未成年人位置", "儿童出生日期", "未成年人出生日期", "学校标识", "学生标识",
    ],
    exact: [
      "profiles of children", "profiles of minors", "children's profiles", "minors' profiles",
      "儿童画像", "未成年人画像",
    ],
  },
  {
    domain: "complex_compliance",
    reason: "The requirement asks the product to determine or guarantee a complex regulatory compliance outcome and requires specialist compliance review.",
    actions: [
      "guarantee", "guarantees", "ensure", "ensures", "certify", "certifies", "determine", "determines",
      "guarantee compliance", "ensure compliance", "certify compliance", "determine compliance", "automate compliance decisions",
      "hipaa compliant", "gdpr compliant", "pci dss compliant", "sox compliant", "fedramp compliant",
      "保证合规", "确保合规", "认证合规", "判定合规", "自动作出合规决定", "自动合规决策", "满足监管认证",
    ],
    subjects: [
      "hipaa", "gdpr", "pci dss", "sox", "fedramp", "regulation", "regulatory regime", "legal compliance",
      "合规", "法规", "监管制度", "法律要求", "监管认证",
    ],
    exact: [
      "cross-border data residency compliance", "cross border data residency compliance",
      "多司法辖区合规", "跨境数据驻留合规", "跨境数据合规",
    ],
  },
  {
    domain: "capability_boundary",
    reason: "The requested product is outside Vibe Blueprint's Web/SaaS/internal-tool/AI-Web architecture boundary.",
    actions: [
      "build", "create", "develop", "design", "implement", "generate", "select a stack", "choose a stack", "architect",
      "构建", "创建", "开发", "设计", "实现", "生成", "选择技术栈", "规划架构",
    ],
    subjects: [
      "native-only desktop app", "native only desktop app", "desktop-only native app", "desktop only native app",
      "native-only mobile app", "native only mobile app", "mobile-only native app", "mobile only native app",
      "native-only ios mobile app", "native only ios mobile app", "native-only android mobile app", "native only android mobile app",
      "swiftui iphone app", "swiftui ios app", "uikit iphone app", "android compose app",
      "native desktop application", "native desktop app for windows", "native windows desktop app",
      "firmware", "embedded system", "embedded software", "microcontroller", "device driver",
      "game engine", "safety-critical real-time system", "safety critical real time system",
      "hard real-time system", "hard real time system", "flight control system", "medical device control system",
      "纯原生桌面应用", "纯原生移动应用", "仅原生桌面", "仅原生移动端",
      "固件", "嵌入式系统", "嵌入式软件", "微控制器", "设备驱动", "游戏引擎",
      "安全关键实时系统", "安全攸关实时系统", "硬实时系统", "飞行控制系统", "医疗设备控制系统",
    ],
  },
] as const;

const NEGATION_PREFIX = /(?:\b(?:does not|doesn't|do not|don't|did not|didn't|will not|must not|cannot|can't|won't|is not|isn't|are not|aren't|was not|wasn't|were not|weren't|never|without|no|exclude|excluding|not(?!\s+only\b))\s+(?:\w+\s+){0,4}|(?:不|不会|不能|不得|禁止|无需|没有|未|排除|不涉及)[^，。；,.!?！？]{0,16})$/u;
const CLAUSE_NEGATION = /(?:\b(?:does not|doesn't|do not|don't|did not|didn't|will not|must not|cannot|can't|won't|is not|isn't|are not|aren't|was not|wasn't|were not|weren't|never|without|exclude|excluding|not(?!\s+only\b))\b[^.!?;]{0,80}(?:,|\bor\b|\band\b)\s*|(?:不|不会|不能|不得|禁止|无需|没有|未|排除|不涉及)[^。！？；;]{0,48}(?:、|，|或|也|并)\s*)$/u;
const CONTRAST = /(?:\b(?:but|however|instead|yet)\b|但是|但|而是|却)[^.!?。！？；;]*$/u;
const UNCERTAINTY_PREFIX = /(?:\b(?:(?:not|isn't|is not|hasn't|has not)\s+(?:yet\s+)?(?:decided|determined|known|clear)\s+(?:if|whether)|(?:unclear|unknown|undecided|uncertain)\s+(?:if|whether)|may|might|possibly|perhaps)\s+(?:\w+\s+){0,4}|(?:尚未确定|还没确定|仍未确定|不确定|尚不清楚|还不清楚|可能|也许)(?:是否)?[^，。；,.!?！？]{0,16})$/u;
const CAPABILITY_REFERENCE_GAP = /(?:\b(?:dashboard|page|report|status|monitor|documentation|docs|plugin|integration|display|displays|show|shows|view|views)\b|仪表盘|页面|报告|状态|监控|文档|插件|集成|展示|显示|查看)/u;
const MEDICAL_RECORD_CONTEXT = /(?:\b(?:existing|historical|stored|recorded|records?|archive|display|shows?|views?|read-only)\b|既有|已有|历史|记录|归档|展示|查看|只读)/u;

function normalizeText(value: string): string {
  return redactSensitiveText(value)
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\t\r\n]+/gu, " ")
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function isAsciiWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[a-z0-9]/u.test(character);
}

function findMatches(text: string, term: string): readonly SignalMatch[] {
  const normalizedTerm = normalizeText(term);
  if (normalizedTerm.length === 0) return [];
  const needsWordBoundaries = /^[a-z0-9 ]+$/u.test(normalizedTerm);
  const matches: SignalMatch[] = [];
  let offset = 0;
  while (offset <= text.length - normalizedTerm.length) {
    const start = text.indexOf(normalizedTerm, offset);
    if (start === -1) break;
    const end = start + normalizedTerm.length;
    if (
      !needsWordBoundaries ||
      (!isAsciiWordCharacter(text[start - 1]) && !isAsciiWordCharacter(text[end]))
    ) {
      matches.push({ start, end, term: normalizedTerm });
    }
    offset = Math.max(start + 1, end);
  }
  return matches;
}

function locallyNegated(text: string, match: SignalMatch): boolean {
  const directPrefix = text.slice(Math.max(0, match.start - 48), match.start);
  if (NEGATION_PREFIX.test(directPrefix) || UNCERTAINTY_PREFIX.test(directPrefix)) return true;
  const clausePrefix = text.slice(Math.max(0, match.start - 112), match.start);
  if (CONTRAST.test(clausePrefix)) return false;
  return CLAUSE_NEGATION.test(clausePrefix);
}

function positiveMatches(text: string, terms: readonly string[]): readonly SignalMatch[] {
  return terms
    .flatMap((term) => findMatches(text, term))
    .filter((match) => !locallyNegated(text, match))
    .sort((left, right) => left.start - right.start || right.end - left.end || left.term.localeCompare(right.term));
}

function matchesOnePredicate(text: string, rule: BoundaryRule): boolean {
  if (positiveMatches(text, rule.exact ?? []).length > 0) return true;
  const actions = positiveMatches(text, rule.actions);
  const subjects = positiveMatches(text, rule.subjects);
  return actions.some((action) => subjects.some((subject) => {
    const start = Math.min(action.start, subject.start);
    const end = Math.max(action.end, subject.end);
    if (end - start > 120) return false;
    const between = text.slice(Math.min(action.end, subject.end), Math.max(action.start, subject.start));
    if (/[.!?;。！？；]/u.test(text.slice(start, end))) return false;
    if (
      rule.domain === "medical" &&
      (action.term === "diagnosis" || action.term === "diagnoses")
    ) {
      const context = text.slice(Math.max(0, action.start - 36), Math.min(text.length, action.end + 36));
      if (MEDICAL_RECORD_CONTEXT.test(context)) return false;
    }
    if (rule.domain !== "capability_boundary") return true;
    // A boundary term can be untrusted subject matter rather than the product
    // being requested (for example, "a Web dashboard that displays game-engine
    // build status"). Include the short suffix so noun phrases such as "build
    // status" cannot turn the nearby word "build" into a product-building verb.
    const relationship = text.slice(
      Math.min(action.end, subject.end),
      Math.min(text.length, Math.max(action.start, subject.start) + 48),
    );
    return !CAPABILITY_REFERENCE_GAP.test(`${between} ${relationship}`);
  }));
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

function evidenceTexts(input: DetectFoundationBoundaryRisksInput): readonly string[] {
  return [
    normalizeText(input.requirement),
    ...input.facts
      .filter((fact) => fact.value !== false && fact.certainty !== "unknown_critical")
      .map((fact) => normalizeText(factText(fact)))
      .filter((text) => text.length > 0),
  ];
}

export function detectFoundationBoundaryRisks(
  input: DetectFoundationBoundaryRisksInput,
): readonly RiskDomainAssessment[] {
  const texts = evidenceTexts(input);
  return RULES
    .filter((rule) => texts.some((text) => matchesOnePredicate(text, rule)))
    .map((rule) => ({
      domain: rule.domain,
      severity: "critical" as const,
      requires_escalation: true,
      reason: rule.reason,
    }));
}

const SEVERITY_RANK: Readonly<Record<RiskState["level"], number>> = {
  low: 0,
  moderate: 1,
  high: 2,
  critical: 3,
};

function strongerAssessment(
  current: RiskDomainAssessment | undefined,
  detected: RiskDomainAssessment,
): RiskDomainAssessment {
  if (current === undefined) return detected;
  const currentRank = SEVERITY_RANK[current.severity];
  const detectedRank = SEVERITY_RANK[detected.severity];
  return {
    domain: current.domain,
    severity: currentRank >= detectedRank ? current.severity : detected.severity,
    requires_escalation: current.requires_escalation || detected.requires_escalation,
    reason: currentRank > detectedRank || (currentRank === detectedRank && current.requires_escalation)
      ? current.reason
      : detected.reason,
  };
}

export function mergeFoundationBoundaryRisks(
  riskState: RiskState,
  detected: readonly RiskDomainAssessment[],
): RiskState {
  if (detected.length === 0) return riskState;
  const byDomain = new Map<RiskDomainAssessment["domain"], RiskDomainAssessment>();
  for (const assessment of riskState.domains) {
    byDomain.set(
      assessment.domain,
      strongerAssessment(byDomain.get(assessment.domain), assessment),
    );
  }
  for (const assessment of detected) {
    byDomain.set(
      assessment.domain,
      strongerAssessment(byDomain.get(assessment.domain), assessment),
    );
  }
  // RiskDomainSchema has fewer than 20 values, so consolidating duplicate
  // assessments by domain preserves the strongest severity/escalation while
  // guaranteeing that deterministic additions remain schema-valid.
  const domains = [...byDomain.values()];
  const reasons = [...new Set([
    ...riskState.reasons,
    ...detected.map((assessment) => assessment.reason),
  ])].slice(0, 20);
  return {
    level: SEVERITY_RANK[riskState.level] >= SEVERITY_RANK.critical
      ? riskState.level
      : "critical",
    domains,
    reasons,
  };
}

export function enforceFoundationBoundaryRisks(
  requirement: string,
  facts: readonly FoundationFact[],
  riskState: RiskState,
): RiskState {
  return mergeFoundationBoundaryRisks(
    riskState,
    detectFoundationBoundaryRisks({ requirement, facts }),
  );
}
