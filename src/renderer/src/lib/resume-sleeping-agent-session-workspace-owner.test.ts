import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

function makeRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: 'finish the task',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

// Session parity, step 7 (OS#1): the activation sweep re-keyed a paired owner's records onto fresh
// client-minted tabs and relaunched them there (C4). A workspace this computer does not own sweeps
// nothing: its records are captures for the owner's ledger to vouch for or retire.
describe('resumeSleepingAgentSessionsForWorktree in a workspace another computer owns', () => {
  const PAIRED_ENV = '93513683-3ff0-4499-bd79-3c03122c7365'

  function seed(repos: { id: string; executionHostId: string }[]): SleepingAgentSessionRecord {
    const record = makeRecord({ worktreeId: 'repo-1::/work', origin: 'worktree-sleep' })
    useAppStore.setState({
      repos: repos.map((repo) => ({ ...repo, path: '/work', displayName: 'work', addedAt: 1 })),
      tabsByWorktree: { 'repo-1::/work': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)
    return record
  }

  it('returns 0 and touches nothing when a paired runtime owns the workspace (peer)', () => {
    const record = seed([{ id: 'repo-1', executionHostId: `runtime:${PAIRED_ENV}` }])

    expect(resumeSleepingAgentSessionsForWorktree('repo-1::/work')).toBe(0)
    expect(useAppStore.getState().tabsByWorktree['repo-1::/work']).toEqual([])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toEqual(record)
  })

  it('returns 0 when the saved catalog cannot settle the owner (unresolved)', () => {
    const record = seed([
      { id: 'repo-1', executionHostId: `runtime:${PAIRED_ENV}` },
      { id: 'repo-1', executionHostId: 'local' }
    ])

    expect(resumeSleepingAgentSessionsForWorktree('repo-1::/work')).toBe(0)
    expect(useAppStore.getState().tabsByWorktree['repo-1::/work']).toEqual([])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toEqual(record)
  })

  it('still resumes in a workspace this computer owns', () => {
    seed([{ id: 'repo-1', executionHostId: 'local' }])

    expect(resumeSleepingAgentSessionsForWorktree('repo-1::/work')).toBe(1)
    expect(useAppStore.getState().tabsByWorktree['repo-1::/work']).toHaveLength(1)
  })
})
