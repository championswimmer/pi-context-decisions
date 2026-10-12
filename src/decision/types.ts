/** Portable, text/JSON-only data. Images are deliberately outside the initial contract. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type DecisionState = Record<string, JsonValue>;

export interface BoolQuestion {
  type: "bool";
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  /** Ordered rubric levels, lowest first. */
  criteria: string[];
}

export type DecisionQuestion = BoolQuestion | ChoiceQuestion | ScoreQuestion;
export type DecisionQuestions = Record<string, DecisionQuestion>;

export interface DecisionRequest {
  state: DecisionState;
  questions: DecisionQuestions;
}

/** Provider metadata is optional; absence must not be replaced with invented values. */
export interface AnswerMetadata {
  confidence?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
}

export interface BoolAnswer extends AnswerMetadata {
  type: "bool";
  /** Probability of true in [0, 1], not a hard Boolean. */
  probability: number;
}

export interface ChoiceAnswer extends AnswerMetadata {
  type: "choice";
  choice: string;
}

export interface ScoreAnswer extends AnswerMetadata {
  type: "score";
  /** Expected zero-based rubric index in [0, criteria.length - 1]; may be fractional. */
  score: number;
}

export type DecisionAnswer = BoolAnswer | ChoiceAnswer | ScoreAnswer;

/** Canonical usage units: tokens and USD. Each measurement is optional. */
export interface DecisionUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cost?: number;
}

export type BackendId = "pi" | "typesafe" | "openai" | "openrouter";

export interface DecisionResponse {
  answers: Record<string, DecisionAnswer>;
  backend?: BackendId;
  requestId?: string;
  provider?: string;
  model?: string;
  usage?: DecisionUsage;
}

export interface DecisionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** One portable backend contract; provider wire names never reach applications. */
export interface DecisionBackend {
  readonly id: BackendId;
  readonly model: string;
  decide(request: DecisionRequest, options?: DecisionOptions): Promise<DecisionResponse>;
}
