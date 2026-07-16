import path from "node:path";

import { redactSensitiveText, truncateUtf8 } from "./security.js";

const EXCLUDED_SEGMENT = /(?:^|\/)(?:\.git|node_modules|dist|build|out|coverage|\.next|\.nuxt|vendor)(?:\/|$)/iu;
const SENSITIVE_FILE = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmrc|\.pypirc|\.netrc|\.git-credentials|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|auth(?:\.[^/]*)?|[^/]*private[^/]*|id_(?:rsa|dsa|ecdsa|ed25519)|application_default_credentials\.json|[^/]*\.(?:pem|key|p12|pfx|jks|keystore))(?:$|\/)/iu;
const SENSITIVE_DIRECTORY = /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.config\/gcloud|\.gem)(?:\/|$)/iu;
const CODE_LIKE_LINE = /(?:\b(?:function|class|interface|const|let|var|import|export|SELECT|INSERT|CREATE TABLE)\b|=>|[{};]{2,}|^\s*(?:from\s+\S+\s+import\s+|def\s+\w+\s*\(|package\s+\w+|func\s+(?:\([^)]*\)\s*)?\w+\s*\(|use\s+[\w:]+|(?:pub\s+)?(?:fn|struct|enum|impl)\s+\w+|(?:public|private|protected|static|final)\s+[^:]+[;{]))/u;
const SOURCE_BLOCK = /```(?:python|py|go|java|kotlin|rust|rs|c|cpp|csharp|cs|ruby|rb|php|swift|typescript|javascript|tsx|jsx|sql)?\s*[\s\S]*?```/iu;

function normalizeDiffPath(raw: string): string {
  return raw.replace(/^"|"$/gu, "").replace(/^b\//u, "").split("\t", 1)[0] ?? raw;
}

function isExcludedDiffPath(filePath: string | undefined): boolean {
  if (filePath === undefined) return true;
  const normalized = filePath.replaceAll(path.sep, "/");
  return EXCLUDED_SEGMENT.test(normalized) ||
    SENSITIVE_DIRECTORY.test(normalized) ||
    SENSITIVE_FILE.test(normalized);
}

export function sanitizeRepositoryDiff(input: string, maximumBytes = 60_000): string {
  const output: string[] = [];
  let currentPath: string | undefined;
  let includeCurrent = false;
  let phase: "outside" | "headers" | "hunk" = "outside";
  let sawOldFileHeader = false;
  let sawNewFileHeader = false;
  for (const line of input.split(/\r?\n/u)) {
    if (line.startsWith("diff --git ")) {
      currentPath = undefined;
      includeCurrent = false;
      phase = "headers";
      sawOldFileHeader = false;
      sawNewFileHeader = false;
      continue;
    }

    if (phase === "headers" && !sawOldFileHeader && line.startsWith("--- ")) {
      sawOldFileHeader = true;
      continue;
    }
    if (
      phase === "headers" &&
      sawOldFileHeader &&
      !sawNewFileHeader &&
      line.startsWith("+++ ")
    ) {
      const raw = line.slice(4).trim();
      currentPath = raw === "/dev/null" ? undefined : normalizeDiffPath(raw);
      includeCurrent = !isExcludedDiffPath(currentPath);
      if (includeCurrent) output.push(`FILE: ${currentPath}`);
      sawNewFileHeader = true;
      continue;
    }
    if (phase === "headers" && sawNewFileHeader && line.startsWith("@@")) {
      phase = "hunk";
      continue;
    }
    if (phase !== "hunk" || !includeCurrent || currentPath === undefined) continue;
    if (line.startsWith("+")) {
      output.push(`+${redactSensitiveText(line.slice(1))}`);
    }
  }
  return truncateUtf8(output.join("\n"), maximumBytes).text;
}

export function sanitizeProjectSummary(input: string, maximumBytes = 16_000): string {
  const redacted = redactSensitiveText(input);
  if (SOURCE_BLOCK.test(redacted)) {
    throw new Error("project_summary appears to contain source code; summary mode accepts only a plain structural summary");
  }
  const lines = redacted.split(/\r?\n/u);
  const codeLike = lines.filter((line) => CODE_LIKE_LINE.test(line)).length;
  const sourceSignals = [
    /\b(?:import|export)\s+(?:default|const|let|var|function|class|interface|type|\{)/u,
    /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/u,
    /\bfunction\s+[A-Za-z_$][\w$]*\s*\(/u,
    /=>/u,
    /[{}].*;/u,
    /^\s*(?:from\s+\S+\s+import\s+|import\s+\S+|def\s+\w+\s*\(|class\s+\w+[^:]*:)/mu,
    /^\s*(?:package\s+\w+|func\s+(?:\([^)]*\)\s*)?\w+\s*\(|type\s+\w+\s+struct\s*\{)/mu,
    /^\s*(?:use\s+[\w:]+|(?:pub\s+)?(?:fn|struct|enum|impl)\s+\w+)/mu,
    /^\s*(?:(?:public|private|protected|static|final)\s+)+(?:class\s+\w+|[^:]+[;{])/mu,
  ].filter((pattern) => pattern.test(redacted)).length;
  if (
    (lines.length >= 8 && codeLike / lines.length > 0.45) ||
    sourceSignals >= 2 ||
    (sourceSignals >= 1 && codeLike >= 3)
  ) {
    throw new Error("project_summary appears to contain source code; summary mode accepts only a plain structural summary");
  }
  return truncateUtf8(redacted, maximumBytes).text;
}
