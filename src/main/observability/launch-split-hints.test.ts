import { afterEach, describe, expect, it } from 'vitest'
import {
  noteLaunchTriggerHint,
  takeLaunchCauseHints,
  _resetLaunchTriggerHintsForTests
} from './launch-trigger-hints'
const tabId = '11111111-1111-4111-8111-111111111111'
const first = '22222222-2222-4222-8222-222222222222'
const second = '33333333-3333-4333-8333-333333333333'
afterEach(_resetLaunchTriggerHintsForTests)
describe('split provenance reservation', () => {
  it('retains two concurrent split identities and never consumes one for an unrelated leaf', () => {
    for (const leafId of [first, second]) {
      noteLaunchTriggerHint({
        tabId,
        leafId,
        trigger: 'cli',
        launchCause: { trigger: 'cli', requestId: leafId, parentPaneKey: `${tabId}:${leafId}` }
      } as never)
    }
    expect(takeLaunchCauseHints({ tabId, leafId: tabId } as never).tabCause).toBeNull()
    expect(takeLaunchCauseHints({ tabId, leafId: second } as never).tabCause).toEqual({
      trigger: 'cli',
      requestId: second,
      parentPaneKey: `${tabId}:${second}`
    })
    expect(takeLaunchCauseHints({ tabId, leafId: first } as never).tabCause).toEqual({
      trigger: 'cli',
      requestId: first,
      parentPaneKey: `${tabId}:${first}`
    })
    expect(takeLaunchCauseHints({ tabId, leafId: first } as never).tabCause).toBeNull()
  })
})
