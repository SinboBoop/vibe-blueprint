export type UnsupportedTechnologyClaimKind =
  | "unverified_exact_version"
  | "unverified_specific_price"
  | "unverifiable_absolute_capability";

export interface UnsupportedTechnologyClaim {
  readonly kind: UnsupportedTechnologyClaimKind;
  readonly excerpt: string;
}

interface LocatedMatch {
  readonly index: number;
  readonly text: string;
}

const PRICE_PATTERNS = [
  /(?:[$€£¥￥]\s*\d+(?:[.,]\d+)?|\b(?:USD|EUR|GBP|CNY|RMB)\s*\d+(?:[.,]\d+)?\b)/giu,
  /\b\d+(?:[.,]\d+)?\s*(?:USD|EUR|GBP|CNY|RMB|dollars?|euros?|pounds?)\b/giu,
  /\b\d+(?:[.,]\d+)?\s*(?:per\s+(?:month|year|user|seat)|\/(?:mo(?:nth)?|yr|year|user|seat))\b/giu,
  /\b(?:free\s+(?:tier|plan|forever)|costs?\s+nothing|no-cost\s+(?:tier|plan))\b/giu,
  /\d+(?:[.,]\d+)?\s*(?:元|美元|人民币)\s*(?:\/|每)?\s*(?:月|年|用户|席位)?/gu,
  /(?:免费套餐|免费额度|永久免费|每月\s*\d+(?:[.,]\d+)?\s*元)/gu,
] as const;

const EXACT_VERSION_PATTERNS = [
  /\b(?:version|ver(?:sion)?\.?)[\s:=-]*v?\d+(?:\.\d+){0,2}\b/giu,
  /(?:版本|版)[\s:=-]*v?\d+(?:\.\d+){0,2}\b/gu,
  /\b[a-z][a-z0-9._/-]{0,80}@v?\d+(?:\.\d+){0,2}\b/giu,
  /\bv\d+(?:\.\d+){0,2}\b/giu,
  /\b[A-Z][A-Za-z0-9.+/_-]{1,60}\s+\d+\.\d+\.\d+\b/gu,
  /\b(?:node(?:\.js)?|react|next(?:\.js)?|vue|nuxt|svelte|angular|typescript|postgresql|mysql|mariadb|sqlite|redis|mongodb|prisma|drizzle|tailwind(?:\s+css)?|vite|vitest|jest|playwright|express|fastify|nestjs|django|flask|rails|ruby|python|golang|rust|java|kotlin|swift|docker|kubernetes|terraform|opentofu)\s+\d+\b/giu,
] as const;

const ABSOLUTE_CAPABILITY_PATTERNS = [
  /\bunlimited(?:\s+(?:storage|requests?|users?|seats?|traffic|bandwidth|usage|scale|capacity))?\b/giu,
  /\b100\s*%\s*(?:compliant|compliance|secure|security|available|availability|reliable|reliability|uptime|guaranteed)?\b/giu,
  /\b(?:zero[-\s]+downtime|zero[-\s]+failures?|never\s+fails?|always\s+available|fully\s+compliant|automatically\s+compliant|guaranteed\s+(?:uptime|availability|compliance|security)|unbreakable|perfectly\s+secure)\b/giu,
  /(?:无限(?:制|容量|请求|用户|流量|存储)?|100\s*%\s*(?:合规|安全|可用|可靠)?|零故障|零停机|永不失败|完全合规|绝对安全)/gu,
] as const;

function collectMatches(text: string, patterns: readonly RegExp[]): readonly LocatedMatch[] {
  const matches: LocatedMatch[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      matches.push({ index: match.index, text: match[0] });
    }
  }
  return matches;
}

function isExplicitRange(text: string, match: LocatedMatch): boolean {
  const before = text.slice(Math.max(0, match.index - 4), match.index);
  const after = text.slice(match.index + match.text.length, match.index + match.text.length + 24);
  return /(?:\^|~|>=?|<=?)\s*$/u.test(before) ||
    /^\s*(?:\+|\.x\b|\.\*|x\b|or\s+(?:newer|later)|and\s+(?:newer|later)|及以上|以上|或更高)/iu.test(after);
}

function isNegatedClaim(text: string, match: LocatedMatch): boolean {
  const before = text.slice(Math.max(0, match.index - 48), match.index);
  const after = text.slice(match.index + match.text.length, match.index + match.text.length + 40);
  return /(?:\b(?:not|cannot|can't|doesn't|does\s+not|isn't|is\s+not|never\s+claims?|without)\b|(?:不|无法|不能|并非|不是|不保证))[^.!?。！？]{0,28}$/iu.test(before) ||
    /^[^.!?。！？]{0,24}(?:\b(?:is\s+not|isn't|cannot\s+be|is\s+never)\s+guaranteed\b|(?:无法保证|不能保证|不保证|并非保证))/iu.test(after);
}

function excerpt(text: string, match: LocatedMatch): string {
  const start = Math.max(0, match.index - 24);
  const end = Math.min(text.length, match.index + match.text.length + 24);
  return text.slice(start, end).replace(/\s+/gu, " ").trim();
}

/**
 * Reject model-authored facts that require fresh external evidence. Foundation
 * Vibe Blueprint has no authoritative technology catalog, so it deliberately
 * accepts ranges/latest-stable wording and fails closed on exact claims.
 */
export function findUnsupportedTechnologyClaims(
  text: string,
): readonly UnsupportedTechnologyClaim[] {
  const findings: UnsupportedTechnologyClaim[] = [];
  const seen = new Set<string>();
  const add = (kind: UnsupportedTechnologyClaimKind, match: LocatedMatch): void => {
    const key = `${kind}\0${match.index}\0${match.text.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ kind, excerpt: excerpt(text, match) });
  };

  for (const match of collectMatches(text, EXACT_VERSION_PATTERNS)) {
    if (!isExplicitRange(text, match)) add("unverified_exact_version", match);
  }
  for (const match of collectMatches(text, PRICE_PATTERNS)) {
    add("unverified_specific_price", match);
  }
  for (const match of collectMatches(text, ABSOLUTE_CAPABILITY_PATTERNS)) {
    if (!isNegatedClaim(text, match)) add("unverifiable_absolute_capability", match);
  }
  return findings;
}
