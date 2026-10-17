import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionChainRowInfo } from '@/lib/session-chain-runner'

vi.mock('@/lib/session-chain-client', () => ({
  upsertSessionChainOnHost: vi.fn(),
  removeSessionChainOnHost: vi.fn()
}))
vi.mock('@/lib/session-chain-support', () => ({ LOCAL_CHAIN_TARGET: { kind: 'local' } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))

import { conversationPlanFixture } from '@/lib/conversation-plan-fixture'
import { clearSessionChainEntries, setSessionChainEntry } from '@/lib/session-chain-registry'
import { preferredSessionChain } from '@/lib/session-chain-row-choice'
import { sessionChainRowsByRowKey } from './use-session-chain-by-row-key'

function info(chainId: string): SessionChainRowInfo {
  return {
    chainId,
    rowKey: 'source',
    queued: 1,
    total: 1,
    state: 'waiting',
    auto: true,
    error: null,
    destination: { kind: 'done' },
    blocked: null,
    launchedPaneKeys: []
  }
}

afterEach(() => clearSessionChainEntries())

describe('sessionChainRowsByRowKey', () => {
  it('keeps the row info of the chain the row speaks for, whatever order the rows arrive in', () => {
    const sealed = conversationPlanFixture()
    sealed.id = 'sealed'
    sealed.createdAt = 9
    sealed.outcomeSet!.completion = {
      at: 50,
      outcomes: [{ id: 'outcome', revision: 1 }],
      evidenceIds: []
    }
    const open = conversationPlanFixture()
    open.id = 'open'
    open.createdAt = 1
    setSessionChainEntry(sealed)
    setSessionChainEntry(open)
    const chosen = preferredSessionChain([sealed, open], 1_000_000_000)!
    expect(chosen.id).toBe('open')
    const chainByRowKey = new Map([['source', chosen]])
    // Why: list order used to decide, so the queue line could describe one chain and the plan
    // state another.
    for (const rows of [
      [info('open'), info('sealed')],
      [info('sealed'), info('open')]
    ]) {
      expect(sessionChainRowsByRowKey(rows, chainByRowKey).get('source')?.chainId).toBe('open')
    }
  })

  it('keeps a row whose chain this device cannot resolve', () => {
    expect(sessionChainRowsByRowKey([info('unknown')], new Map()).get('source')?.chainId).toBe(
      'unknown'
    )
  })
})
