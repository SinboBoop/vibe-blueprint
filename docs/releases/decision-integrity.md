# Decision Integrity release notes

Status: the source repository is public; the npm package is not published. This document defines the supported release boundary and records only checks that were actually run.

## Supported release scope

This is a bounded correctness release for the Vibe Blueprint local stdio MCP server. It supports the current five architecture patterns for early Web apps, SaaS products, internal tools, and AI Web products:

- `static_demo`
- `managed_modular_monolith`
- `separated_api_monolith`
- `self_hosted_modular_monolith`
- `offline_first`

The release addresses known failures in requested model diagnostics, ordinary-expense versus material-financial activity classification, critical security/privacy escalation, route-order fallback, three-or-more-route ambiguity, and minimum pattern safeguards. It does not turn Vibe Blueprint into a universal technology or compliance advisor.

## Compatibility contract

- All eight existing `foundation_*` MCP tool names remain unchanged.
- Committed project-foundation state remains schema version 1; no project-state migration is required.
- Existing `decide`, `confirm_fact`, `offer_two_routes`, and `escalate` meanings remain intact.
- `abstain` is an additive interaction mode for `no_feasible_route`, `too_many_material_routes`, or `no_deterministic_winner`.
- Activity-risk, elimination, and invariant traces are additive response fields.

An older client that assumes exactly four interaction modes must be updated before using this release. `abstain` is a successful decision response with no selected route. A host must present the reason and recovery data, must not treat it as specialist escalation or transport failure, and must not silently substitute its own recommendation.

The package's primary executables are `vibe-blueprint` and `vibe-blueprint-mcp`, and new client examples use the `vibe_blueprint` registration key. The former pre-release executable names remain temporary compatibility aliases. Existing `FOUNDATION_*` settings, `.project-foundation/` state, `PROJECT-FOUNDATION.md`, and schema version 1 remain stable contracts.

## Minimum invariant gate

The runtime registry validates exactly five safeguard families:

| Family | Minimum contract |
| --- | --- |
| Authoritative production records | A presentation-only `static_demo` cannot own authoritative business state. |
| Offline continuity | `offline_first` plus durable local operations, an explicit sync protocol, conflict handling, and idempotent server application. |
| Multi-organization isolation | An explicit organization data-owner boundary and server-side isolation. |
| Real payments | Callback authenticity, idempotent processing, reconciliation, and failure recovery. |
| Sensitive data | Server-side authorization, auditability, retention/deletion handling, and storage/transit protection. |

This gate checks that a validated route does not contradict a pattern and declares every required minimum ID. It does not inspect implementation code or independently prove the declaration. Passing it is not a security audit, compliance determination, vendor-capability verification, or production-readiness certificate.

## Regression inventory record

The checked-in regression inventory contains:

| Measure | Current record |
| --- | ---: |
| Maintainer-reviewed case families | 36 |
| Derived variants linked to a reviewed family | 8 |
| Total cases | 44 |
| Original-family languages | 35 English, 1 mixed-language, 0 Chinese-only |
| Derived-variant languages | 3 English, 3 Chinese, 2 mixed-language |
| Derived transformations | 3 translations; 1 each paraphrase, negation, permutation, material flip, and prompt injection |

Category coverage includes requested diagnostics; ordinary expense and record-only financial workflows; invoice payment negation; ambiguous financial scope; actual money movement; credit and investment decisions; routine and critical security/privacy boundaries; optional and required offline work; single- and multi-organization boundaries; disposable and production static-demo use; real-payment and sensitive-data safeguards; equivalent, dominated, eliminated-recommendation, two-route, and three-or-more-route cases; candidate permutation; bilingual/mixed-language input; material fact flips; and prompt injection.

These are controlled, offline, maintainer-reviewed regression families. Derived variants do not increase the reviewed-family count. The inventory is not sampled to represent all software projects, is not independently expert-labelled, and is not evidence of general accuracy or superiority over DeepSeek, Codex, Claude, or another model.

## Known limitations

- One internal model call still authors candidate facts, route capabilities, scores, explanations, and invariant declarations before deterministic checks.
- The existing 0–100 route scores are not empirically calibrated; this release removes unsafe positional fallback and abstains on unresolved ambiguity.
- Natural-language consequence equivalence remains narrower and less reliable than a future typed-consequence system, especially across paraphrases and languages.
- Activity rules cover a small reviewed vocabulary and are not a general legal, financial, medical, security, privacy, or jurisdiction policy engine.
- Minimum invariant IDs prove declared completeness only; source implementation is not inspected for those safeguards.
- There is no authoritative technology evidence or compatibility catalog. The current implementation therefore rejects model-authored exact versions, prices, and absolute vendor promises and permits compatibility ranges or install-time latest-stable wording; it still cannot independently establish stack freshness or positive vendor capabilities.
- There is no automatic local project observer; internal analysis can know less about an existing repository than a host that has read it.
- Pending `analysis_id` state is process-local and is lost when the MCP server restarts.
- Change scanning is conservative signal detection, not semantic whole-program analysis. It covers staged, tracked-unstaged, and ordinary untracked source content but does not compute every merge-base/workspace/rename semantic needed by a complete release system.
- Continuous enforcement, hooks, CI, protected-branch integration, and one-command onboarding are not included.
- The supported patterns and inventory are intentionally Web/SaaS/internal-tool oriented; unsupported combinations must abstain or receive specialist review.

## Out of scope

Long-term research, hosted services, organization analytics, and unimplemented enforcement features are outside this source release. The supported behavior is limited to the capabilities and limitations documented above; future ideas are not implied product commitments.

## Release verification

Before publishing or calling this release complete, maintainers must pass repository lint, strict typecheck, build, the complete test suite, offline regression inventory, MCP protocol integration, installed-tarball stdio E2E, Skill identity/eval-schema validation, exact legacy-brand checking, package-content checking, and the secret scan. A provider-backed verification record is separate from these offline checks and must identify its own scope and time; it must not be generalized into a production-readiness claim.

The final results for the exact commit or tag being published belong in the release record. Results from an earlier checkout, or from a working tree modified after a run, are not release evidence for the new artifact.
