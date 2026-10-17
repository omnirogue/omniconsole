import type { Store } from '../persistence'
import type { LocalMetaActionScope } from '../automations/local-meta-action-authority'
import { readRoutineDecisionSource } from './routine-decision-records'

export function captureRoutineActionScope(
  options: {
    store: Store
    active(): boolean
    assertActionEnabled?: (routineId: string) => void
  },
  routineId: string,
  runId: string,
  verificationOnly: boolean
): Omit<LocalMetaActionScope, 'target'> {
  const source = verificationOnly
    ? null
    : readRoutineDecisionSource(options.store, routineId, runId).source
  const isCurrent = () => {
    try {
      if (
        !options.active() ||
        options.store.automationOwnerPrecondition(routineId)?.selector.kind !== 'self'
      ) {
        return false
      }
      if (!verificationOnly) {
        if (
          !options.assertActionEnabled ||
          readRoutineDecisionSource(options.store, routineId, runId).source !== source
        ) {
          return false
        }
        options.assertActionEnabled(routineId)
      }
      return true
    } catch {
      return false
    }
  }
  return {
    routineId,
    runId,
    isCurrent,
    assertCurrent: async () => {
      if (!isCurrent()) {
        throw new Error('The current routine, owner or advertising action mode changed.')
      }
    }
  }
}
