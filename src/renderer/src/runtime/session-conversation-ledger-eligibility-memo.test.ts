import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import {
  memoizedConversationLedgerEligibility,
  resetConversationLedgerEligibilityMemoForTests
} from './session-conversation-ledger-eligibility-memo'

function state(overrides: Partial<AppState> = {}): AppState {
  return {
    repos: [],
    worktreesByRepo: {},
    tabsByWorktree: {},
    sleepingAgentSessionsByPaneKey: {},
    agentStatusByPaneKey: {},
    ...overrides
  } as AppState
}

const chains: never[] = []

beforeEach(() => resetConversationLedgerEligibilityMemoForTests())

// Session parity, review B1: one sidebar change costs one eligibility build, however many
// readers (publisher, headings, management rows, parity population) follow it.
describe('memoizedConversationLedgerEligibility', () => {
  it('computes once for one set of input identities and again when a read slice changes', () => {
    const compute = vi.fn(() => ({ published: new Set<string>(), quarantined: new Map() }))
    const base = state()
    const view = { deleted: [] as string[] }
    const first = memoizedConversationLedgerEligibility(base, view, chains, compute)
    expect(memoizedConversationLedgerEligibility(base, view, chains, compute)).toBe(first)
    // A fresh store object with the same slices is the same input.
    expect(memoizedConversationLedgerEligibility({ ...base }, view, chains, compute)).toBe(first)
    expect(compute).toHaveBeenCalledTimes(1)

    memoizedConversationLedgerEligibility(state({ tabsByWorktree: {} }), view, chains, compute)
    expect(compute).toHaveBeenCalledTimes(2)
    memoizedConversationLedgerEligibility(
      state({ tabsByWorktree: {} }),
      { deleted: ['gone'] },
      chains,
      compute
    )
    expect(compute).toHaveBeenCalledTimes(3)
  })

  it('ignores a status ping that moves no row, as the sidebar does', () => {
    const compute = vi.fn(() => ({ published: new Set<string>(), quarantined: new Map() }))
    const entry = {
      paneKey: 'tab:leaf',
      tabId: 'tab',
      worktreeId: 'repo::/w',
      agentType: 'claude',
      state: 'working',
      providerSession: { key: 'session_id', id: 's1' }
    }
    const view = { deleted: [] as string[] }
    const shared = state()
    const pinged = (tokens: number): AppState => ({
      ...shared,
      agentStatusByPaneKey: { 'tab:leaf': { ...entry, tokens } } as never
    })
    memoizedConversationLedgerEligibility(pinged(1), view, chains, compute)
    memoizedConversationLedgerEligibility(pinged(2), view, chains, compute)
    expect(compute).toHaveBeenCalledTimes(1)
  })
})
