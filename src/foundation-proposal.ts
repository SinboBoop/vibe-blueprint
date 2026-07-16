import type { StoredAnalysis } from "./analysis-store.js";
import { filterFactsForAffectedCapabilities } from "./assessment.js";
import type { PresentedRoute } from "./schemas.js";
import type { EvidenceCheck, FoundationProposal } from "./state.js";

export interface CommitAnalysisOptions {
  readonly selectedRouteId?: string;
  readonly includedCapabilities?: readonly string[];
  readonly excludedCapabilities?: readonly string[];
  readonly undecidedCapabilities?: readonly string[];
  readonly evidenceChecks?: readonly EvidenceCheck[];
  readonly protectionCoverage?: unknown;
}

function selectedRoute(analysis: StoredAnalysis, selectedRouteId: string | undefined): PresentedRoute | undefined {
  const decision = analysis.decision;
  if (decision.interaction_mode !== "offer_two_routes") {
    if (selectedRouteId !== undefined) {
      throw new Error("selected_route_id is only valid for an offer_two_routes analysis");
    }
    return undefined;
  }
  if (selectedRouteId === undefined) {
    throw new Error("selected_route_id is required before committing an offered two-route decision");
  }
  const selected = decision.routes.find((route) => route.id === selectedRouteId);
  if (selected === undefined) throw new Error("selected_route_id does not name one of the offered routes");
  return selected;
}

function mergeFactsByKey(baseFacts: readonly unknown[], replacementFacts: readonly unknown[]): readonly unknown[] {
  const replacementKeys = new Set(
    replacementFacts.flatMap((fact) =>
      fact !== null && typeof fact === "object" && typeof (fact as { readonly key?: unknown }).key === "string"
        ? [(fact as { readonly key: string }).key]
        : [],
    ),
  );
  return [
    ...baseFacts.filter((fact) =>
      fact === null ||
      typeof fact !== "object" ||
      typeof (fact as { readonly key?: unknown }).key !== "string" ||
      !replacementKeys.has((fact as { readonly key: string }).key),
    ),
    ...replacementFacts,
  ];
}

function appendUniqueStrings(
  values: readonly string[],
  addition: string,
): readonly string[] {
  return values.includes(addition) ? values : [...values, addition];
}

function decisionIdentity(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const candidate = value as {
    readonly analysis_id?: unknown;
    readonly recommendation?: unknown;
    readonly selected_route_id?: unknown;
    readonly affected_capabilities?: unknown;
  };
  return JSON.stringify({
    analysis_id: candidate.analysis_id ?? null,
    recommendation: candidate.recommendation ?? null,
    selected_route_id: candidate.selected_route_id ?? null,
    affected_capabilities: candidate.affected_capabilities ?? null,
  });
}

function appendUniqueDecision(values: readonly unknown[], addition: unknown): readonly unknown[] {
  const identity = decisionIdentity(addition);
  return values.some((value) => decisionIdentity(value) === identity)
    ? values
    : [...values, addition];
}

export function proposalFromAnalysis(
  analysis: StoredAnalysis,
  options: CommitAnalysisOptions = {},
): FoundationProposal {
  if (analysis.decision.interaction_mode === "confirm_fact") {
    throw new Error("The outstanding reality question must be answered before committing Foundation state");
  }
  if (analysis.decision.interaction_mode === "abstain") {
    throw new Error("An abstained analysis cannot be committed; resolve the missing fact or evidence first");
  }
  if (analysis.decision.interaction_mode === "escalate") {
    throw new Error("An escalated analysis cannot be committed as an approved Foundation without the requested specialist review");
  }
  const route = selectedRoute(analysis, options.selectedRouteId);
  const recommendation = route?.recommendation ?? analysis.decision.recommendation;
  const base = analysis.baseFoundation;
  const scopedReassessment = base !== undefined && analysis.affectedCapabilities !== undefined;
  const architectureShapingChange = analysis.affectedCapabilities?.some((capability) =>
    ["offline", "payment", "multitenancy", "sensitive_data", "production_data", "general_foundation"].includes(capability),
  ) ?? false;
  const decisionEntry = {
    analysis_id: analysis.analysisId,
    recommendation,
    major_drawback: route?.major_drawback ?? analysis.decision.major_drawback,
    change_condition: route?.change_condition ?? analysis.decision.change_condition,
    interaction_mode: analysis.decision.interaction_mode,
    ...(analysis.affectedCapabilities === undefined ? {} : { affected_capabilities: analysis.affectedCapabilities }),
    ...(route === undefined ? {} : { selected_route_id: route.id }),
  };
  const reassessedFacts = scopedReassessment
    ? filterFactsForAffectedCapabilities(
        analysis.decision.facts,
        analysis.affectedCapabilities ?? [],
      )
    : analysis.decision.facts;
  return {
    project_summary: analysis.projectSummary ?? base?.project_summary ?? analysis.request,
    facts: base === undefined
      ? reassessedFacts
      : mergeFactsByKey(base.facts, reassessedFacts),
    assumptions: base === undefined
      ? [route?.key_assumption ?? analysis.decision.key_assumption]
      : appendUniqueStrings(base.assumptions, route?.key_assumption ?? analysis.decision.key_assumption),
    decisions: base === undefined ? [decisionEntry] : appendUniqueDecision(base.decisions, decisionEntry),
    included_capabilities: options.includedCapabilities ?? base?.included_capabilities ?? [],
    excluded_capabilities: options.excludedCapabilities ?? base?.excluded_capabilities ?? [],
    undecided_capabilities: options.undecidedCapabilities ?? base?.undecided_capabilities ?? [],
    architecture: scopedReassessment && !architectureShapingChange
      ? base.architecture
      : route?.architecture ?? analysis.decision.architecture,
    technology_stack: scopedReassessment && !architectureShapingChange
      ? base.technology_stack
      : route?.proposed_stack ?? analysis.decision.proposed_stack,
    reassessment_triggers: appendUniqueStrings(
      base?.reassessment_triggers ?? [],
      analysis.decision.change_condition,
    ),
    risk_state: analysis.decision.risk_state,
    protection_coverage: options.protectionCoverage ?? base?.protection_coverage ?? {
      foundation_state: true,
      hooks: false,
      ci: false,
      protected_branches: false,
    },
    evidence_checks: options.evidenceChecks ?? base?.evidence_checks ?? [],
  };
}
