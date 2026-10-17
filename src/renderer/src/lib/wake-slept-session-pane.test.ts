import { afterEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store.state } }))

import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { getProviderSessionClaimKey } from './sleeping-agent-pane-ownership'
import { otherSleepingClaimKeys, wakeSleptSessionPane } from './wake-slept-session-pane'

function record(paneKey: string, id: string, worktreeId = 'wt'): SleepingAgentSessionRecord {
  return {
    paneKey,
    worktreeId,
    agent: 'claude',
    providerSession: { key: 'session_id', id },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1
  }
}

describe('otherSleepingClaimKeys', () => {
  it('pre-claims every other sleeping session in the worktree so only the opened one wakes', () => {
    const records = {
      a: record('a', 'one'),
      b: record('b', 'two'),
      c: record('c', 'three', 'other-wt')
    }
    const claimed = otherSleepingClaimKeys(records, 'wt', 'a')
    expect(claimed).toEqual(new Set([getProviderSessionClaimKey(records.b)]))
    expect(claimed?.has(getProviderSessionClaimKey(records.a))).toBe(false)
  })

  it('does nothing for a row that is not asleep', () => {
    expect(otherSleepingClaimKeys({}, 'wt', 'a')).toBeNull()
    expect(otherSleepingClaimKeys({ a: record('a', 'one', 'other') }, 'wt', 'a')).toBeNull()
  })
})

describe('wakeSleptSessionPane (session parity, step 6, C4/F10)', () => {
  const WT = 'repo-a::/project-a'
  const owner = {
    environmentId: 'env-studio',
    state: 'ready',
    asOf: 1,
    generation: 'gen-1',
    revision: 1,
    source: 'window',
    listedAt: 1,
    folders: [],
    projects: [],
    omitted: { unknownHost: 0, unverified: 0 },
    removals: []
  }

  function pairedState(owners: Record<string, unknown>): Record<string, unknown> {
    return {
      repos: [{ id: 'repo-a', executionHostId: 'runtime:env-studio' }],
      worktreesByRepo: { 'repo-a': [{ id: WT, repoId: 'repo-a', hostId: 'runtime:env-studio' }] },
      sleepingAgentSessionsByPaneKey: { a: record('a', 'one', WT), b: record('b', 'two', WT) },
      mirroredConversationOwnersByEnvironment: owners
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    store.state = {}
  })

  it('never wakes a pane under a paired OmniConsole that publishes its ledger', () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', { dispatchEvent })
    store.state = pairedState({ 'env-studio': owner })
    expect(wakeSleptSessionPane(WT, 'a')).toBe(false)
    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it('keeps today’s wake under a runtime with no ledger (an older owner, a driven runtime)', () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', { dispatchEvent })
    store.state = pairedState({})
    wakeSleptSessionPane(WT, 'a')
    expect(dispatchEvent).toHaveBeenCalledTimes(1)
  })
})
