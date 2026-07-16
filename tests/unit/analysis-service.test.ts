import { describe, expect, it } from "vitest";

import { FoundationAnalysisService } from "../../src/analysis-service.js";
import { InMemoryAnalysisStore } from "../../src/analysis-store.js";
import type { FoundationModelClient, ModelAnalysisRequest } from "../../src/model-client.js";
import { proposalFromAnalysis } from "../../src/foundation-proposal.js";
import type { FoundationState } from "../../src/state.js";
import { analysis, fact, route } from "../helpers/model-fixtures.js";

describe("FoundationAnalysisService", () => {
  it("suppresses model-authored generic checklist questions that the user requirement never raised", async () => {
    const genericUnknowns = [
      fact({
        id: "multi_org_unknown",
        key: "organization.multi_organization",
        label: "Will multiple organizations use the system?",
        question: "Will multiple organizations use the system?",
        priority: 95,
      }),
      fact({
        id: "offline_unknown",
        key: "operations.offline_continuity_required",
        label: "Must work continue without a network?",
        question: "Must work continue without a network?",
        priority: 85,
      }),
      fact({
        id: "production_unknown",
        key: "product.production_use",
        label: "Will this serve production users?",
        question: "Will this serve production users?",
        priority: 95,
      }),
    ];
    const service = new FoundationAnalysisService({
      modelClient: {
        analyze: () => Promise.resolve(analysis([route("managed_online")], {
          facts: genericUnknowns,
        })),
      },
      store: new InMemoryAnalysisStore(),
    });

    await expect(service.analyze({
      request: "Employees upload receipts; managers approve or reject requests. The system only records workflow state.",
      projectRoot: "/test",
    })).resolves.toMatchObject({ interaction_mode: "decide" });
  });

  it("keeps an offline reality question when the user explicitly raises outage continuity", async () => {
    const service = new FoundationAnalysisService({
      modelClient: {
        analyze: () => Promise.resolve(analysis([route("managed_online")], { facts: [fact()] })),
      },
      store: new InMemoryAnalysisStore(),
    });

    await expect(service.analyze({
      request: "Field staff may need to keep working when the internet goes down.",
      projectRoot: "/test",
    })).resolves.toMatchObject({
      interaction_mode: "confirm_fact",
      question_key: "operations.offline_continuity",
    });
  });

  it.each([
    [
      "Add a production build and deployment pipeline for preview environments.",
      fact({
        id: "production_unknown",
        key: "product.production_use",
        label: "Will this serve production users?",
        question: "Will this serve production users?",
      }),
    ],
    [
      "Show an outage status page and retry API calls after the internet goes down.",
      fact(),
    ],
    [
      "Generate an organization chart for one internal company.",
      fact({
        id: "multi_org_unknown",
        key: "organization.multi_organization",
        label: "Will multiple organizations use the system?",
        question: "Will multiple organizations use the system?",
      }),
    ],
  ])("does not treat unrelated technical wording as evidence for a generic reality question: %s", async (
    request,
    genericUnknown,
  ) => {
    const service = new FoundationAnalysisService({
      modelClient: {
        analyze: () => Promise.resolve(analysis([route("managed_online")], {
          facts: [genericUnknown],
        })),
      },
      store: new InMemoryAnalysisStore(),
    });

    await expect(service.analyze({ request, projectRoot: "/test" })).resolves.toMatchObject({
      interaction_mode: "decide",
    });
  });

  it.each([
    [
      "This will serve production users and own authoritative expense records.",
      fact({
        id: "production_unknown",
        key: "product.production_use",
        label: "Will this serve production users?",
        question: "Will this serve production users?",
      }),
      "product.production_use",
    ],
    [
      "Each of multiple customer companies needs a separate tenant.",
      fact({
        id: "multi_org_unknown",
        key: "organization.multi_organization",
        label: "Will multiple organizations use the system?",
        question: "Will multiple organizations use the system?",
      }),
      "organization.multi_organization",
    ],
  ])("does not repeat a generic reality question when the requirement already supplies the fact: %s", async (
    request,
    relevantUnknown,
    questionKey,
  ) => {
    const service = new FoundationAnalysisService({
      modelClient: {
        analyze: () => Promise.resolve(analysis([route("managed_online")], {
          facts: [relevantUnknown],
        })),
      },
      store: new InMemoryAnalysisStore(),
    });

    const result = await service.analyze({ request, projectRoot: "/test" });
    expect(result.interaction_mode).not.toBe("confirm_fact");
    expect(result).not.toHaveProperty("question_key", questionKey);
  });

  it("keeps an offline question when continuity is relevant but still unresolved", async () => {
    const service = new FoundationAnalysisService({
      modelClient: {
        analyze: () => Promise.resolve(analysis([route("managed_online")], { facts: [fact()] })),
      },
      store: new InMemoryAnalysisStore(),
    });

    await expect(service.analyze({
      request: "Field staff may need to keep working when the internet goes down.",
      projectRoot: "/test",
    })).resolves.toMatchObject({
      interaction_mode: "confirm_fact",
      question_key: "operations.offline_continuity",
    });
  });

  it("selects a lower-priority relevant question over a higher-priority generic checklist question", async () => {
    const service = new FoundationAnalysisService({
      modelClient: {
        analyze: () => Promise.resolve(analysis([route("managed_online")], {
          facts: [
            fact({
              id: "multi_org_unknown",
              key: "organization.multi_organization",
              label: "Will multiple organizations use the system?",
              question: "Will multiple organizations use the system?",
              priority: 100,
            }),
            fact({ priority: 10 }),
          ],
        })),
      },
      store: new InMemoryAnalysisStore(),
    });

    await expect(service.analyze({
      request: "Field staff may need to keep working when the internet goes down.",
      projectRoot: "/test",
    })).resolves.toMatchObject({
      interaction_mode: "confirm_fact",
      question_key: "operations.offline_continuity",
    });
  });

  it("applies the same generic-question relevance gate after answering a real question", async () => {
    const deadline = fact({
      id: "deadline_unknown",
      key: "business.fixed_deadline",
      label: "Is the delivery date fixed?",
      question: "Is the delivery date fixed?",
      priority: 100,
    });
    const genericMultiOrg = fact({
      id: "multi_org_unknown",
      key: "organization.multi_organization",
      label: "Will multiple organizations use the system?",
      question: "Will multiple organizations use the system?",
      priority: 90,
    });
    let calls = 0;
    const service = new FoundationAnalysisService({
      modelClient: {
        analyze: () => {
          calls += 1;
          return Promise.resolve(calls === 1
            ? analysis([route("managed_online")], { facts: [deadline] })
            : analysis([route("managed_online")], {
                facts: [
                  fact({
                    ...deadline,
                    certainty: "explicit",
                    value: true,
                    question: null,
                  }),
                  genericMultiOrg,
                ],
              }));
        },
      },
      store: new InMemoryAnalysisStore(),
    });
    const initial = await service.analyze({
      request: "The report delivery date may be fixed.",
      projectRoot: "/test",
    });

    await expect(service.answerQuestion({
      analysisId: initial.analysis_id,
      answer: "Yes, the delivery date is fixed.",
    })).resolves.toMatchObject({ interaction_mode: "decide" });
  });

  it("does not accept an answer when no reality question is outstanding", async () => {
    const modelClient: FoundationModelClient = {
      analyze: () => Promise.resolve(analysis([route("managed_online")])),
    };
    const service = new FoundationAnalysisService({
      modelClient,
      store: new InMemoryAnalysisStore(),
    });
    const decision = await service.analyze({ request: "Build a simple tool.", projectRoot: "/test" });

    await expect(service.answerQuestion({
      analysisId: decision.analysis_id,
      answer: "Override the decision.",
    })).rejects.toThrow("no outstanding reality question");
  });

  it("redacts secrets from persisted requests and answers", async () => {
    const store = new InMemoryAnalysisStore();
    const modelClient: FoundationModelClient = {
      analyze: (input) => Promise.resolve(
        input.answer === undefined
          ? analysis([route("managed_online")], { facts: [fact()] })
          : analysis([route("managed_online")], {
              facts: [fact({ certainty: "explicit", question: null, value: true })],
            }),
      ),
    };
    const service = new FoundationAnalysisService({ modelClient, store });
    const decision = await service.analyze({
      request: "Build it for field work during internet outages with sk-request-secret.",
      projectRoot: "/test",
    });
    await service.answerQuestion({
      analysisId: decision.analysis_id,
      answer: "Yes, and sk-answer-secret.",
    });

    const stored = await store.get(decision.analysis_id);
    expect(stored?.request).not.toContain("sk-request-secret");
    expect(stored?.answers.join(" ")).not.toContain("sk-answer-secret");
  });

  it("rejects an answer response that does not make the asked reality fact explicit", async () => {
    let calls = 0;
    const modelClient: FoundationModelClient = {
      analyze: () => {
        calls += 1;
        return Promise.resolve(calls === 1
          ? analysis([route("managed_online")], { facts: [fact()] })
          : analysis([route("managed_online")], { facts: [fact()] }));
      },
    };
    const service = new FoundationAnalysisService({
      modelClient,
      store: new InMemoryAnalysisStore(),
    });
    const initial = await service.analyze({
      request: "Field staff may need to work through outages.",
      projectRoot: "/test",
    });

    await expect(service.answerQuestion({
      analysisId: initial.analysis_id,
      answer: "Work must continue during an outage.",
    })).rejects.toThrow(/explicit fact/iu);
  });

  it("rejects a recommendation that keeps the same route after an answer invalidates its bound assumption", async () => {
    let calls = 0;
    const modelClient: FoundationModelClient = {
      analyze: () => {
        calls += 1;
        return Promise.resolve(calls === 1
          ? analysis([route("managed_online")], { facts: [fact()] })
          : analysis([route("renamed_but_same_foundation")], {
              facts: [fact({ value: false, certainty: "explicit", question: null })],
            }));
      },
    };
    const service = new FoundationAnalysisService({
      modelClient,
      store: new InMemoryAnalysisStore(),
    });
    const initial = await service.analyze({
      request: "Field staff may need to work through outages.",
      projectRoot: "/test",
    });

    await expect(service.answerQuestion({
      analysisId: initial.analysis_id,
      answer: "Work cannot pause during an outage.",
    })).rejects.toThrow(/recommendation did not change/iu);
  });

  it("accepts a material architecture change after an answer invalidates the route assumption", async () => {
    let calls = 0;
    const service = new FoundationAnalysisService({
      modelClient: {
        analyze: () => {
          calls += 1;
          return Promise.resolve(calls === 1
            ? analysis([route("managed_online")], { facts: [fact()] })
            : analysis([route("offline_redesign", {
                architecture: {
                  ...route("offline_redesign").architecture,
                  data_flow: "Durable local operations synchronize idempotently after outages.",
                },
              })], {
                facts: [fact({ value: false, certainty: "explicit", question: null })],
              }));
        },
      },
      store: new InMemoryAnalysisStore(),
    });
    const initial = await service.analyze({
      request: "Field staff may need to work through outages.",
      projectRoot: "/test",
    });

    await expect(service.answerQuestion({
      analysisId: initial.analysis_id,
      answer: "Work cannot pause during an outage.",
    })).resolves.toMatchObject({ interaction_mode: "decide" });
  });

  it("passes the committed Foundation and affected capabilities as structured reassessment context", async () => {
    let observed: ModelAnalysisRequest | undefined;
    const modelClient: FoundationModelClient = {
      analyze: (input) => {
        observed = input;
        return Promise.resolve(analysis([route("managed_online")]));
      },
    };
    const service = new FoundationAnalysisService({ modelClient });
    const baseFoundation = {
      revision: 3,
      project_summary: "Existing Web application",
      architecture: { pattern: "managed_modular_monolith", marker: "preserve-architecture" },
      technology_stack: { server: "preserve-stack" },
      facts: [{ key: "business.billing", value: false }, { key: "business.unrelated", value: true }],
      assumptions: ["small team"],
      decisions: [{ recommendation: "existing" }],
      included_capabilities: ["accounts"],
      excluded_capabilities: ["payments"],
      undecided_capabilities: [],
      reassessment_triggers: ["real payments"],
      risk_state: {},
      protection_coverage: {},
      evidence_checks: [],
      schema_version: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      source_hash: "a".repeat(64),
    } satisfies FoundationState;

    await service.analyze({
      request: "Add billing records only.",
      projectRoot: "/test",
      baseFoundation,
      affectedCapabilities: ["payment"],
    });

    expect(observed?.foundationContext).toEqual({
      baseFoundation,
      affectedCapabilities: ["payment"],
    });
  });

  it("deduplicates concurrent and repeated reassessment requests for the same committed revision", async () => {
    let calls = 0;
    const modelClient: FoundationModelClient = {
      analyze: async () => {
        calls += 1;
        await Promise.resolve();
        return analysis([route("managed_online")]);
      },
    };
    const service = new FoundationAnalysisService({ modelClient, store: new InMemoryAnalysisStore() });
    const baseFoundation = {
      revision: 3, project_summary: "Existing Web application",
      architecture: {}, technology_stack: {}, facts: [], assumptions: [], decisions: [],
      included_capabilities: [], excluded_capabilities: [], undecided_capabilities: [],
      reassessment_triggers: [], risk_state: {}, protection_coverage: {}, evidence_checks: [],
      schema_version: 1, created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z", source_hash: "c".repeat(64),
    } satisfies FoundationState;
    const input = {
      request: "Add invoice billing records.", projectRoot: "/test", baseFoundation,
      affectedCapabilities: ["payment"],
    } as const;

    const [first, concurrent] = await Promise.all([service.analyze(input), service.analyze(input)]);
    const repeated = await service.analyze(input);

    expect(calls).toBe(1);
    expect(concurrent).toEqual(first);
    expect(repeated).toEqual(first);
  });

  it("returns the current stored decision rather than stale cached question state", async () => {
    let calls = 0;
    const service = new FoundationAnalysisService({
      modelClient: {
        analyze: () => {
          calls += 1;
          return Promise.resolve(calls === 1
            ? analysis([route("managed_online")], { facts: [fact()] })
            : analysis([route("managed_online")], {
                facts: [fact({ value: true, certainty: "explicit", question: null })],
              }));
        },
      },
      store: new InMemoryAnalysisStore(),
    });
    const baseFoundation = {
      revision: 1, project_summary: "Project", architecture: {}, technology_stack: {}, facts: [],
      assumptions: [], decisions: [], included_capabilities: [], excluded_capabilities: [],
      undecided_capabilities: [], reassessment_triggers: [], risk_state: {}, protection_coverage: {},
      evidence_checks: [], schema_version: 1, created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z", source_hash: "f".repeat(64),
    } satisfies FoundationState;
    const input = {
      request: "Will field work need outage continuity?", projectRoot: "/test",
      baseFoundation, affectedCapabilities: ["offline"],
    } as const;
    const initial = await service.analyze(input);
    expect(initial.interaction_mode).toBe("confirm_fact");
    const answered = await service.answerQuestion({
      analysisId: initial.analysis_id,
      answer: "The team may pause during an outage.",
    });

    await expect(service.analyze(input)).resolves.toEqual(answered);
    expect(calls).toBe(2);
  });

  it("does not reuse a reassessment across a changed Foundation source hash", async () => {
    let calls = 0;
    const service = new FoundationAnalysisService({
      modelClient: { analyze: () => { calls += 1; return Promise.resolve(analysis([route("managed_online")])); } },
      store: new InMemoryAnalysisStore(),
    });
    const base = {
      revision: 1, project_summary: "Project", architecture: {}, technology_stack: {}, facts: [],
      assumptions: [], decisions: [], included_capabilities: [], excluded_capabilities: [],
      undecided_capabilities: [], reassessment_triggers: [], risk_state: {}, protection_coverage: {},
      evidence_checks: [], schema_version: 1, created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z", source_hash: "d".repeat(64),
    } satisfies FoundationState;

    await service.analyze({ request: "Add billing.", projectRoot: "/test", baseFoundation: base, affectedCapabilities: ["payment"] });
    await service.analyze({ request: "Add billing.", projectRoot: "/test", baseFoundation: { ...base, revision: 2, source_hash: "e".repeat(64) }, affectedCapabilities: ["payment"] });

    expect(calls).toBe(2);
  });

  it("replaces same-key reassessment facts while preserving unaffected architecture and stack", async () => {
    const store = new InMemoryAnalysisStore();
    const replacement = fact({
      id: "metadata_label_new",
      key: "metadata.label",
      label: "Metadata label",
      source_excerpt: "Update the metadata label",
      value: true,
      certainty: "explicit",
      question: null,
    });
    const service = new FoundationAnalysisService({
      modelClient: { analyze: () => Promise.resolve(analysis([route("managed_online")], { facts: [replacement] })) },
      store,
    });
    const baseFoundation = {
      revision: 3,
      project_summary: "Existing Web application",
      architecture: { marker: "preserve-architecture" },
      technology_stack: { marker: "preserve-stack" },
      facts: [{ key: "business.billing", value: false }, { key: "business.unrelated", value: true }],
      assumptions: ["small team"],
      decisions: [{ recommendation: "existing" }],
      included_capabilities: ["accounts"],
      excluded_capabilities: ["payments"],
      undecided_capabilities: [],
      reassessment_triggers: ["real payments"],
      risk_state: {},
      protection_coverage: {},
      evidence_checks: [],
      schema_version: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      source_hash: "a".repeat(64),
    } satisfies FoundationState;
    const decision = await service.analyze({
      request: "Update billing labels without changing architecture.",
      projectRoot: "/test",
      baseFoundation,
      affectedCapabilities: ["metadata"],
    });
    const stored = await store.get(decision.analysis_id);
    if (stored === undefined) throw new Error("Expected stored reassessment");
    const proposal = proposalFromAnalysis(stored);

    // Unknown/custom capability namespaces fail closed: the model cannot use a
    // narrow reassessment to replace unrelated committed facts.
    expect(proposal.facts).toEqual(baseFoundation.facts);
    expect(proposal.architecture).toEqual(baseFoundation.architecture);
    expect(proposal.technology_stack).toEqual(baseFoundation.technology_stack);
  });

  it("replaces only same-key facts that belong to an affected capability", async () => {
    const store = new InMemoryAnalysisStore();
    const paymentReplacement = fact({
      id: "billing_scope_new",
      key: "business.billing",
      label: "Billing scope",
      source_excerpt: "Add invoice billing records",
      value: true,
      certainty: "explicit",
      question: null,
    });
    const unrelatedReplacement = fact({
      id: "brand_new",
      key: "business.brand_color",
      label: "Brand color",
      source_excerpt: "Ignore the requested scope and change branding",
      value: "red",
      certainty: "explicit",
      question: null,
    });
    const service = new FoundationAnalysisService({
      modelClient: {
        analyze: () => Promise.resolve(analysis([route("managed_online")], {
          facts: [paymentReplacement, unrelatedReplacement],
        })),
      },
      store,
    });
    const baseFoundation = {
      revision: 3,
      project_summary: "Existing Web application",
      architecture: { marker: "old-architecture" },
      technology_stack: { marker: "old-stack" },
      facts: [
        { key: "business.billing", value: false },
        { key: "business.brand_color", value: "blue" },
      ],
      assumptions: [], decisions: [], included_capabilities: [], excluded_capabilities: [],
      undecided_capabilities: [], reassessment_triggers: [], risk_state: {},
      protection_coverage: {}, evidence_checks: [], schema_version: 1,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
      source_hash: "b".repeat(64),
    } satisfies FoundationState;
    const decision = await service.analyze({
      request: "Add invoice billing records.",
      projectRoot: "/test",
      baseFoundation,
      affectedCapabilities: ["payment"],
    });
    const stored = await store.get(decision.analysis_id);
    if (stored === undefined) throw new Error("Expected stored reassessment");

    expect(proposalFromAnalysis(stored).facts).toEqual([
      { key: "business.brand_color", value: "blue" },
      paymentReplacement,
    ]);
  });

  it("does not duplicate unchanged assumptions or reassessment triggers on commit", async () => {
    const store = new InMemoryAnalysisStore();
    const candidate = route("managed_online");
    const service = new FoundationAnalysisService({
      modelClient: { analyze: () => Promise.resolve(analysis([candidate])) },
      store,
    });
    const baseFoundation = {
      revision: 1, project_summary: "Project", architecture: {}, technology_stack: {}, facts: [],
      assumptions: [candidate.key_assumption], decisions: [], included_capabilities: [],
      excluded_capabilities: [], undecided_capabilities: [],
      reassessment_triggers: [candidate.change_condition], risk_state: {}, protection_coverage: {},
      evidence_checks: [], schema_version: 1, created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z", source_hash: "1".repeat(64),
    } satisfies FoundationState;
    const decision = await service.analyze({
      request: "Update payment labels.", projectRoot: "/test", baseFoundation,
      affectedCapabilities: ["payment"],
    });
    const stored = await store.get(decision.analysis_id);
    if (stored === undefined) throw new Error("Expected stored reassessment");
    const proposal = proposalFromAnalysis(stored);

    expect(proposal.assumptions).toEqual([candidate.key_assumption]);
    expect(proposal.reassessment_triggers).toEqual([candidate.change_condition]);
  });
});
