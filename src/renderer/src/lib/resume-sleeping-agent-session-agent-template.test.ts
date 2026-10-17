import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()
const advertising = { id: 'advertising', name: 'Advertising', digest: 'd30fc78b9495' }

afterEach(() => {
  vi.unstubAllGlobals()
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
    origin: 'quit',
    ...overrides
  }
}

function originTab(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...extra
  }
}

function resumedTemplate(record: SleepingAgentSessionRecord, tab: Record<string, unknown>) {
  useAppStore.setState({
    repos: [{ id: 'repo-1', path: '/repo', connectionId: null, executionHostId: 'local' }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo/wt' }] },
    tabsByWorktree: { 'wt-1': [tab] },
    sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
  } as never)
  expect(resumeSleepingAgentSessionsForWorktree('wt-1', { suppressNavigation: true })).toBe(1)
  return useAppStore.getState().tabsByWorktree['wt-1']?.find((entry) => entry.id !== 'tab-1')
    ?.agentTemplate
}

describe('resuming a conversation into a new tab keeps its agent template', () => {
  it('carries the record captured with the session', () => {
    expect(resumedTemplate(makeRecord({ agentTemplate: advertising }), originTab())).toEqual(
      advertising
    )
  })

  it('falls back to the exited origin tab, whose launched agent is gone', () => {
    expect(resumedTemplate(makeRecord(), originTab({ agentTemplate: advertising }))).toEqual(
      advertising
    )
  })

  it('records nothing when neither says', () => {
    expect(resumedTemplate(makeRecord(), originTab())).toBeUndefined()
  })
})
