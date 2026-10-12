import { DecisionError } from "../decision/errors.ts";
import type { BackendId, DecisionOptions } from "../decision/types.ts";

/** Cleanup-owned deadline, shared by auth, retries, response reads and native classify. */
export function createDeadline(options: DecisionOptions = {}, backend?: BackendId) {
  const timeoutMs = options.timeoutMs ?? 8000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) {
    throw new DecisionError("invalid_request", "Timeout must be in (0, 300000] milliseconds", { backend });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const error = () => new DecisionError(options.signal?.aborted ? "aborted" : "timeout", options.signal?.aborted ? "Decision operation aborted" : "Decision operation timed out", { backend });
  return {
    signal,
    check() { if (signal.aborted) throw error(); },
    async run<T>(operation: Promise<T>): Promise<T> {
      if (signal.aborted) { void operation.catch(() => {}); throw error(); }
      let abort: () => void = () => {};
      const canceled = new Promise<never>((_, reject) => {
        abort = () => reject(error());
        signal.addEventListener("abort", abort, { once: true });
      });
      try { return await Promise.race([operation, canceled]); }
      finally { signal.removeEventListener("abort", abort); }
    },
    close() { clearTimeout(timer); },
  };
}
