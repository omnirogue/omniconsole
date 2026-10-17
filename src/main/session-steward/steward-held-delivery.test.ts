import { describe, expect, it } from 'vitest'
import type {
  SessionPendingDelivery,
  SessionPendingDeliveryState
} from '../../shared/session-pending-delivery-types'
import { pendingDeliveryHolds } from './steward-runtime-sources'

function held(paneKey: string, state: SessionPendingDeliveryState): SessionPendingDelivery {
  return {
    id: `${paneKey}-${state}`,
    createdAt: 1,
    expiresAt: 2,
    actor: { kind: 'cli' },
    target: { paneKey, tabId: null, title: paneKey },
    text: 'Continue with the migration',
    state
  }
}

describe('a prompt #751 holds for a busy session', () => {
  it('keeps the steward away from its pane while it waits or is being sent', () => {
    const store = {
      list: () => [held('tab-1:leaf-1', 'waiting'), held('tab-2:leaf-1', 'delivering')]
    }
    expect(pendingDeliveryHolds(store, 'tab-1:leaf-1')).toBe(true)
    expect(pendingDeliveryHolds(store, 'tab-2:leaf-1')).toBe(true)
    expect(pendingDeliveryHolds(store, 'tab-3:leaf-1')).toBe(false)
  })

  it('releases the pane once the held prompt has settled, and holds nothing with no store', () => {
    const settled = (['delivered', 'refused', 'expired', 'cancelled', 'unknown'] as const).map(
      (state) => held('tab-1:leaf-1', state)
    )
    expect(pendingDeliveryHolds({ list: () => settled }, 'tab-1:leaf-1')).toBe(false)
    expect(pendingDeliveryHolds(null, 'tab-1:leaf-1')).toBe(false)
  })
})
