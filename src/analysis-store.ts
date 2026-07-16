import type { DecisionResult, ModelAnalysis } from "./schemas.js";
import type { FoundationState } from "./state.js";

export interface StoredAnalysis {
  readonly analysisId: string;
  readonly request: string;
  readonly projectRoot: string;
  readonly projectSummary?: string;
  readonly baseFoundation?: FoundationState;
  readonly affectedCapabilities?: readonly string[];
  readonly modelAnalysis: ModelAnalysis;
  readonly decision: DecisionResult;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly answers: readonly string[];
}

export interface AnalysisStore {
  get(analysisId: string): Promise<StoredAnalysis | undefined>;
  set(analysis: StoredAnalysis): Promise<void>;
  delete(analysisId: string): Promise<boolean>;
}

export class InMemoryAnalysisStore implements AnalysisStore {
  readonly #analyses = new Map<string, StoredAnalysis>();
  readonly #maximumEntries: number;

  constructor(maximumEntries = 100) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new Error("maximumEntries must be a positive integer");
    }
    this.#maximumEntries = maximumEntries;
  }

  get(analysisId: string): Promise<StoredAnalysis | undefined> {
    return Promise.resolve(this.#analyses.get(analysisId));
  }

  set(analysis: StoredAnalysis): Promise<void> {
    this.#analyses.delete(analysis.analysisId);
    this.#analyses.set(analysis.analysisId, analysis);
    while (this.#analyses.size > this.#maximumEntries) {
      const oldest = this.#analyses.keys().next().value;
      if (oldest === undefined) break;
      this.#analyses.delete(oldest);
    }
    return Promise.resolve();
  }

  delete(analysisId: string): Promise<boolean> {
    return Promise.resolve(this.#analyses.delete(analysisId));
  }

  clear(): void {
    this.#analyses.clear();
  }
}

export const defaultAnalysisStore = new InMemoryAnalysisStore();
