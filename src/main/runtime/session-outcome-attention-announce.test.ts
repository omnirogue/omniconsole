import { afterEach, expect, it, vi } from 'vitest'
import { ownReviewAttention } from '../../shared/session-attention-drafts'
import type { SessionChain } from '../../shared/session-chain-types'
import { openHumanAttention } from '../../shared/session-human-attention'
import { runDefinition, runScope, runSet } from '../../shared/session-run-lifecycle.test-fixture'
import { setRuntimeDesktopSurface } from './runtime-desktop-surface'
import { announceSessionHumanAttention } from './session-outcome-attention-announce'

afterEach(() => setRuntimeDesktopSurface(null))

function asked() {
  const opened = openHumanAttention(
    runSet([runDefinition('one', { title: 'Ship the report' })]),
    ownReviewAttention({ scope: { ...runScope(), conditionId: 'file' }, title: 'Ship the report' }),
    10
  )
  const chain = { id: 'chn_1', outcomeSet: opened.set } as unknown as SessionChain
  return { chain, requests: opened.set.attention! }
}

it('says what the work is and exactly what is asked, on the desktop’s own notification surface', () => {
  const showNotification = vi.fn(() => true)
  setRuntimeDesktopSurface({
    showNotification,
    findWindowById: () => null,
    onIpc: () => {},
    removeIpcListener: () => {}
  })
  const { chain, requests } = asked()
  announceSessionHumanAttention(chain, requests)
  expect(showNotification).toHaveBeenCalledTimes(1)
  expect(showNotification).toHaveBeenCalledWith({
    title: 'Ship the report',
    body: requests[0]!.ask
  })
})

it('shows nothing, and fails nothing, on a host with no desktop', () => {
  const { chain, requests } = asked()
  expect(() => announceSessionHumanAttention(chain, requests)).not.toThrow()
})
