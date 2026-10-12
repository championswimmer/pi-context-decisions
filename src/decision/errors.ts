import type { BackendId } from "./types.ts";
import { DecisionValidationError } from "./validation.ts";

export type DecisionErrorCode = "config" | "auth" | "invalid_request" | "invalid_response" | "refusal" | "rate_limit" | "http" | "timeout" | "aborted" | "network";
export interface DecisionErrorOptions {
  backend?: BackendId;
  status?: number;
  retryable?: boolean;
  questionId?: string;
  cause?: unknown;
}

/** Do not pass provider text, request state, credentials, or raw transport errors here. */
export class DecisionError extends Error {
  readonly code: DecisionErrorCode;
  readonly backend?: BackendId;
  readonly status?: number;
  readonly retryable: boolean;
  readonly questionId?: string;
  constructor(code: DecisionErrorCode, message: string, options: DecisionErrorOptions = {}) {
    super(message);
    this.name = "DecisionError";
    this.code = code;
    this.backend = options.backend;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.questionId = options.questionId;
    // Only local validation errors are safe causes; arbitrary provider errors can carry secrets.
    if (options.cause instanceof DecisionValidationError) {
      Object.defineProperty(this, "cause", { value: options.cause, configurable: true });
    }
  }
}
export function isDecisionError(error: unknown): error is DecisionError {
  return error instanceof DecisionError;
}
