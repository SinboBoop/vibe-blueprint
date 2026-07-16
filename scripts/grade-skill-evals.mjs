#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const workspace = process.env.VIBE_BLUEPRINT_SKILL_EVAL_WORKSPACE ??
  process.env.FOUNDATION_SKILL_EVAL_WORKSPACE ??
  path.join(os.tmpdir(), "vibe-blueprint-workspace", "iteration-1");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evalDocument = JSON.parse(await readFile(
  path.join(root, "skill/vibe-blueprint/evals/evals.json"),
  "utf8",
));

function hasAffirmativeFailureClaim(text) {
  return /(?:需要|必须|转交|升级到|请(?:找|让)|应由).{0,12}(?:专家|合规复核)/u.test(text) ||
    /(?:发生|出现|由于|因为|属于).{0,10}(?:连接失败|模型失败|工具异常|分析失败)/u.test(text);
}

function recommendsFirstRoute(text) {
  return /(?:我建议|我推荐|建议采用|推荐选择|应该选择|可以选择|就选|直接选|优先选).{0,24}(?:第一条|第一种|路线\s*[AaＡａ])/iu.test(text);
}

function preservesNoWinnerReason(text) {
  const eliminated = /(?:原本|原先|之前|原来).{0,48}(?:路线|方案|首选).{0,64}(?:淘汰|排除|否决|不成立|不满足|违反)/su.test(text) ||
    /(?:原本|原先|之前|原来).{0,48}(?:淘汰|排除|否决|不成立|不满足|违反)/su.test(text);
  const noBasis = /(?:没有|缺少|不足以|找不到).{0,36}(?:可靠|客观|确定|明确).{0,24}(?:依据|判断|结论|赢家|胜出方案)/su.test(text) ||
    /(?:没有明确的胜出方案|没有确定性赢家|无法确定哪条更(?:优|合适)|不能确定哪条更(?:优|合适))/u.test(text);
  const noChoice = /(?:不做决定|不做选择|不替你做决定|没有替你做决定|没有替你做选择|没有替你选择|没有帮你选定|不会硬选|不会替你.*选|没有硬选|主动放弃了选择)/su.test(text);
  return eliminated && noBasis && noChoice;
}

function onlyNamesMissingEvidence(text) {
  const asksQuestion = (text.match(/[?？]/gu) ?? []).length > 0;
  const namesEvidence = /(?:还缺|缺少|需要|补充).{0,30}(?:业务现实|真实业务|业务实际|业务情况|业务后果|实际业务).{0,30}(?:事实|信息|情况|后果|差异)?/su.test(text);
  const inventsExamples = /(?:比如|例如|例如说|譬如|例如包括|包括但不限于)/u.test(text);
  const solicitsAnswer = /(?:告诉我|补充给我|发给我|提供给我|你把.{0,18}(?:给我|告诉我)|我们马上继续|我再据此|等你(?:能)?提供|你(?:能)?提供.{0,18}(?:后|就))/su.test(text);
  return !asksQuestion && namesEvidence && !inventsExamples && !solicitsAnswer;
}

function refusesArbitrarySelection(text) {
  return (/(?:没法|不能|不会|不应|不可以|无法|拒绝|并不安全).{0,48}(?:忽略|随便|第一条|硬选|跳过|替(?:你|它).*(?:选|指定|推荐))/su.test(text) ||
    /(?:忽略|随便|第一条|硬选|跳过).{0,48}(?:没法|不能|不会|不应|不可以|无法|拒绝|并不安全)/su.test(text)) &&
    !recommendsFirstRoute(text);
}

function urgencyIsNotEvidence(text) {
  return /(?:赶时间|着急|催促|时间紧|赶进度|随便选|先别管).{0,48}(?:不能|并不能|不构成|不是|无法|不能靠).{0,48}(?:补上|改变|替代|依据|证据|事实|缺口|跳过)/su.test(text) ||
    /(?:不能靠).{0,24}(?:赶时间|着急|催促|时间紧|赶进度).{0,24}(?:跳过|改变|替代)/su.test(text);
}

function claimsCommitCompleted(text) {
  return /(?:已经|已)(?:完成)?(?:写入|提交|保存|记录)|foundation_commit.{0,12}(?:已|完成|成功)|(?:修订号|revision)\s*[:：]?\s*[A-Za-z0-9_-]+/iu.test(text);
}

function recommendsPaymentArchitecture(text) {
  return /(?:我建议|我推荐|建议采用|推荐使用|应该选择).{0,30}(?:Stripe|支付宝|微信支付|自建支付|支付架构|支付网关)/iu.test(text);
}

const rubric = {
  1: [
    ["明确推荐托管式模块化单体，并说明这是 MCP 的直接决定而非让用户选择框架。", (text) => /托管式.*模块化单体/u.test(text) && !/(?:还是|二选一|选择.*(?:react|vue|数据库))/iu.test(text)],
    ["包含推荐、主要缺点、关键假设和改变条件四项。", (text) => /(?:建议|推荐)/u.test(text) && /(?:缺点|代价)/u.test(text) && /(?:前提|假设)/u.test(text) && /(?:重新评估|什么情况下)/u.test(text)],
    ["不要求金融专家复核，也不把记录/审批报销误写成实际资金控制。", (text) => !hasAffirmativeFailureClaim(text) && !/(?:需要|必须).{0,10}(?:金融专家|合规审查|金融复核)/u.test(text) && /不.*(?:发起|真正|直接).*?(?:付款|打款)/u.test(text)],
  ],
  2: [
    ["只提出返回的 financial_activity_scope 问题，语义不扩张。", (text) => (text.match(/[?？]/gu) ?? []).length === 1 && /记录或审批/u.test(text) && /发起或控制(?:\*\*)?资金/u.test(text) && /信贷决策/u.test(text) && /投资建议/u.test(text)],
    ["不询问 React/Vue、数据库、API、托管或其他技术偏好。", (text) => !/(?:React|Vue|数据库|API|托管|框架)/iu.test(text)],
    ["在范围尚未确认时不声称必须专家复核。", (text) => !hasAffirmativeFailureClaim(text) && !/(?:必须复核|升级为专家)/u.test(text)],
  ],
  3: [
    ["明确说明系统暂不选择路线，并保留 no_deterministic_winner 的实质原因。", (text) => preservesNoWinnerReason(text) && /两条/u.test(text)],
    ["不替 MCP 选第一条路线或生成自己的技术建议。", (text) => /(?:没有替你(?:做)?选择|没有替你选(?:定)?|没有帮你选定|主动放弃了选择|不会硬选|不会替你.*选|我不会.*(?:挑选|选择|指定|推荐))/su.test(text) && !recommendsFirstRoute(text) && !/(?:建议你选择|我推荐|第一条更好)/u.test(text)],
    ["不把 abstain 描述为专家升级、模型连接失败或工具异常。", (text) => !hasAffirmativeFailureClaim(text)],
    ["recovery.question 为 null 时不虚构一个具体问题；只说明需要哪类证据。", (text) => onlyNamesMissingEvidence(text)],
  ],
  4: [
    ["说明 Vibe Blueprint 仍然没有可靠依据选择路线，并保留真实原因。", (text) => (/(?:没有|缺少).{0,36}(?:可靠|客观|确定).{0,24}(?:依据|判断|赢家)/su.test(text) || /没有.{0,24}(?:确定|确定性).{0,24}(?:更优|赢家|胜出)/su.test(text) || /无法确定哪条更(?:优|合适)/u.test(text)) && /(?:原本|原先|之前|原来).{0,48}(?:违反|淘汰|排除|触碰)/su.test(text) && /(?:支付|安全).{0,24}(?:不变量|底线|要求|风险)/su.test(text)],
    ["明确拒绝忽略 abstain 或随便选择第一条路线。", (text) => refusesArbitrarySelection(text)],
    ["不输出宿主自己的路线推荐，也不把赶时间当成决策证据。", (text) => !recommendsFirstRoute(text) && (urgencyIsNotEvidence(text) || /即使赶时间.{0,36}(?:不能|不会|无法).{0,36}(?:随便|硬).{0,18}(?:挑|选|推荐)/su.test(text))],
    ["recovery.question 为 null 时不提出新问题，只说明所缺证据。", (text) => onlyNamesMissingEvidence(text)],
  ],
  5: [
    ["完整展示托管式后端和自建模块化单体两条路线及各自的用户后果。", (text) => /托管式后端/u.test(text) && /更快上线/u.test(text) && /依赖供应商/u.test(text) && /自建模块化单体/u.test(text) && /控制权更高/u.test(text) && /部署和运维/u.test(text)],
    ["不添加第三条路线，也不替用户选定其中一条。", (text) => !/(?:第三|路线\s*[CcＣｃ]|方案\s*[CcＣｃ])/iu.test(text) && !/(?:我建议|我推荐|建议采用|推荐选择|就选|优先选).{0,24}(?:托管|自建|第一|第二)/su.test(text)],
    ["不追加框架、数据库、API 或其他技术偏好问题。", (text) => (text.match(/[?？]/gu) ?? []).length === 0 && !/(?:React|Vue|数据库|API|框架).{0,20}[?？]/iu.test(text)],
  ],
  6: [
    ["说明系统直接发起真实付款已经越过普通项目规划边界。", (text) => /(?:直接发起|控制).{0,12}(?:真实)?付款/u.test(text) && /(?:越过|超出|不属于).{0,20}(?:普通|常规).{0,18}(?:规划|项目)/u.test(text)],
    ["明确要求支付安全与合规复核，并点出需要的两类证据。", (text) => /支付安全/u.test(text) && /合规/u.test(text) && /复核/u.test(text) && /支付服务商/u.test(text) && /资金流/u.test(text) && /适用地区/u.test(text) && /合规要求/u.test(text)],
    ["不自行推荐支付架构，也不声称项目已经生产就绪。", (text) => !recommendsPaymentArchitecture(text) && !/(?:已经|已)(?:达到|具备|可以).*生产就绪|production[- ]ready/iu.test(text)],
  ],
  7: [
    ["明确说明 Vibe Blueprint 审查没有完成。", (text) => /Vibe Blueprint/iu.test(text) && (/(?:没有|未能|无法).{0,12}(?:完成|进行).{0,12}(?:审查|分析|规划)/u.test(text) || /(?:审查|分析|规划).{0,12}(?:没有|未能|无法).{0,12}(?:完成|进行)?/u.test(text))],
    ["准确指出阻塞原因是尚未配置 LLM API Key。", (text) => /(?:未|没有|尚未).{0,12}(?:配置|设置).{0,12}(?:LLM\s*)?API\s*Key/iu.test(text)],
    ["不伪造推荐技术栈、分析结果或成功状态。", (text) => !/(?:建议|推荐)(?:采用|使用|选择).{0,30}(?:React|Vue|Next|Node|Postgres|技术栈)/iu.test(text) && !/(?:审查|分析|规划).{0,8}(?:已完成|成功)/u.test(text)],
  ],
  8: [
    ["完整展示准备记录的建议、假设和重新评估条件。", (text) => /托管式模块化单体/u.test(text) && /(?:暂不|不会).{0,12}(?:控制|发起).{0,12}(?:真实)?付款/u.test(text) && /(?:开始|如果|未来).{0,12}(?:发起|控制).{0,12}付款.{0,18}(?:重新评估|重评)/u.test(text)],
    ["明确询问用户是否确认写入。", (text) => /(?:确认|同意).{0,12}(?:写入|记录|保存)|(?:写入|记录|保存).{0,12}(?:确认|同意)/u.test(text) && /[?？]/u.test(text)],
    ["不声称 foundation_commit 已运行、记录已保存或已有修订号。", (text) => !claimsCommitCompleted(text)],
  ],
  9: [
    ["明确说明不需要启动 Vibe Blueprint，因为这是普通样式修复且不改变项目基础。", (text) => /(?:不需要|无需).{0,12}(?:启动|使用)?\s*Vibe Blueprint/iu.test(text) && /(?:样式|CSS)/iu.test(text) && /不改变.{0,12}(?:项目)?基础/u.test(text)],
    ["建议按普通 CSS 或响应式样式问题处理。", (text) => /(?:直接|按).{0,12}(?:CSS|响应式|样式).{0,12}(?:修复|处理|调整)/iu.test(text)],
    ["不重新选择技术栈，也不把问题扩大为架构或生产就绪评估。", (text) => !/(?:重新|重选|选择).{0,12}技术栈/u.test(text) && !/(?:需要|应该).{0,12}(?:架构|生产就绪).{0,12}(?:评估|审查)/u.test(text)],
  ],
  10: [
    ["明确说明无需 Vibe Blueprint，因为这是不改变项目基础的孤立调整。", (text) => /(?:不需要|无需).{0,12}(?:启动|使用)?\s*Vibe Blueprint/iu.test(text) && /(?:孤立|局部|小范围|单一).{0,12}(?:调整|改动|功能)/u.test(text) && /不改变.{0,12}(?:项目)?基础/u.test(text)],
    ["建议直接实现并测试上传大小校验。", (text) => /(?:直接|可以).{0,12}(?:实现|增加|添加).{0,18}(?:5MB|大小).{0,12}(?:校验|限制)/iu.test(text) && /测试/u.test(text)],
    ["不启动基础重评、foundation_commit 或新的技术栈选择。", (text) => !/(?:启动|进行|需要).{0,12}(?:基础重评|重新评估项目基础)/u.test(text) && !/foundation_commit/iu.test(text) && !/(?:重新|新的).{0,12}(?:选择|确定).{0,12}技术栈/u.test(text)],
  ],
};

const evalCases = new Map(evalDocument.evals.map((evalCase) => [evalCase.id, evalCase]));
for (const [evalIdText, checks] of Object.entries(rubric)) {
  const evalId = Number(evalIdText);
  const evalCase = evalCases.get(evalId);
  if (evalCase === undefined) throw new Error(`Rubric references missing eval ${evalId}.`);
  const rubricTexts = checks.map(([text]) => text);
  if (JSON.stringify(rubricTexts) !== JSON.stringify(evalCase.expectations)) {
    throw new Error(`Rubric text drift for eval ${evalId}; update evals.json and grader together.`);
  }
}
if (evalCases.size !== Object.keys(rubric).length) {
  throw new Error("Every Skill eval must have a deterministic rubric.");
}

if (process.argv.includes("--validate-only")) {
  process.stdout.write(`${JSON.stringify({
    valid: true,
    skill_name: evalDocument.skill_name,
    deterministic_rubrics: Object.keys(rubric).length,
    assertions: Object.values(rubric).reduce((sum, checks) => sum + checks.length, 0),
  }, null, 2)}\n`);
} else {
  for (const evalId of Object.keys(rubric).map(Number)) {
    const evalDirName = (await import("node:fs/promises")).readdir(workspace).then((names) =>
      names.find((name) => name.startsWith(`eval-${evalId}-`)),
    );
    const resolvedName = await evalDirName;
    if (resolvedName === undefined) throw new Error(`Missing eval ${evalId}`);
    for (const configuration of ["with_skill", "old_skill"]) {
      const runDir = path.join(workspace, resolvedName, configuration, "run-1");
      const answer = await readFile(path.join(runDir, "outputs/answer.md"), "utf8");
      const metrics = JSON.parse(await readFile(path.join(runDir, "outputs/metrics.json"), "utf8"));
      const timing = JSON.parse(await readFile(path.join(runDir, "timing.json"), "utf8"));
      const expectations = rubric[evalId].map(([text, check]) => {
        const passed = check(answer);
        return {
          text,
          passed,
          evidence: passed
            ? `Deterministic content check passed against answer.md: ${answer.trim().slice(0, 220)}`
            : `Required or prohibited content check failed against answer.md: ${answer.trim().slice(0, 220)}`,
        };
      });
      const passed = expectations.filter((expectation) => expectation.passed).length;
      await writeFile(path.join(runDir, "grading.json"), JSON.stringify({
        expectations,
        summary: {
          passed,
          failed: expectations.length - passed,
          total: expectations.length,
          pass_rate: passed / expectations.length,
        },
        execution_metrics: metrics,
        timing,
        claims: [],
        user_notes_summary: { uncertainties: [], needs_review: [], workarounds: [] },
        eval_feedback: {
          suggestions: [],
          overall: "These deterministic checks cover faithful presentation of all five interaction modes, Doctor failure handling, commit confirmation, and ordinary-change scope boundaries. One run per configuration is functional evidence only, not a statistical or general quality claim.",
        },
      }, null, 2));
    }
  }
}
