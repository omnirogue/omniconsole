import type { DecisionRequest, DecisionResult } from '../../shared/structured-decisions'

export function notifyDecisionObserver(
  observer: ((request: DecisionRequest, result: DecisionResult) => void) | undefined,
  request: DecisionRequest,
  result: DecisionResult
): void {
  try {
    observer?.(request, structuredClone(result))
  } catch {
    // Optional observations cannot change the admitted baseline result.
  }
}
