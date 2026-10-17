import type { SessionFinishAction } from '@/lib/session-folders'
import type { SessionFinishChoice } from '../../../../shared/session-finish-intent'

/** Where a finished session goes; none leaves it in Done. */
export type WhenFinishedValue = {
  finish: 'none' | 'close' | 'save'
  folderId?: string
}

export const DEFAULT_WHEN_FINISHED: WhenFinishedValue = { finish: 'none' }

/** An absent choice and legacy Complete both leave the session in Done. */
export function whenFinishedFrom(
  action: SessionFinishAction | SessionFinishChoice | null | undefined
): WhenFinishedValue {
  if (!action) {
    return DEFAULT_WHEN_FINISHED
  }
  const folderId = 'folderId' in action ? action.folderId : null
  return action.action === 'save'
    ? { finish: 'save', ...(folderId ? { folderId } : {}) }
    : action.action === 'end'
      ? { finish: 'close' }
      : DEFAULT_WHEN_FINISHED
}

/** Close → `end`, Save → `save`: the two finish actions the Done block can still produce. */
export function sessionFinishActionFrom(value: WhenFinishedValue): SessionFinishAction {
  return value.finish === 'save'
    ? { action: 'save', folderId: value.folderId ?? null }
    : { action: value.finish === 'close' ? 'end' : 'me', folderId: null }
}
