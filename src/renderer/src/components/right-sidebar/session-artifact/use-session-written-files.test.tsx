// @vitest-environment happy-dom
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'

const mocks = vi.hoisted(() => ({
  environmentId: null as string | null,
  list: vi.fn(async (_target: unknown, session: { provider: string; sessionId: string }) =>
    session.sessionId === 'session-b' ? ['/w/b.md'] : ['/w/a.md']
  )
}))
vi.mock('./session-artifact-client', () => ({ listSessionWrittenFiles: mocks.list }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => mocks.environmentId
}))

import { useSessionWrittenFiles } from './use-session-written-files'

const PANE = 'term:tab-1:pane-1'
const session = {
  rowKey: 'row',
  paneKey: PANE,
  kind: 'terminal',
  worktreeId: 'w'
} as SidebarSession

function status(sessionId: string | null): void {
  useAppStore.setState({
    agentStatusByPaneKey: {
      [PANE]: {
        paneKey: PANE,
        agentType: 'kimi',
        state: 'done',
        prompt: 'p',
        updatedAt: 1,
        stateStartedAt: 1,
        stateHistory: [],
        ...(sessionId ? { providerSession: { key: 'session_id', id: sessionId } } : {})
      } as AgentStatusEntry
    }
  } as never)
}

afterEach(() => {
  cleanup()
  useAppStore.setState({ agentStatusByPaneKey: {} } as never)
  mocks.environmentId = null
  mocks.list.mockClear()
})

describe('useSessionWrittenFiles', () => {
  it('lists what the on-screen provider session wrote, from this host', async () => {
    status('session-b')
    const { result } = renderHook(() => useSessionWrittenFiles(session, true))
    await waitFor(() => expect(result.current).toEqual(['/w/b.md']))
    expect(mocks.list).toHaveBeenCalledWith(
      { kind: 'local' },
      { provider: 'kimi', sessionId: 'session-b' }
    )
  })

  it('asks the paired runtime that runs the session', async () => {
    mocks.environmentId = 'env-1'
    status('session-b')
    renderHook(() => useSessionWrittenFiles(session, true))
    await waitFor(() =>
      expect(mocks.list).toHaveBeenCalledWith(
        { kind: 'environment', environmentId: 'env-1' },
        { provider: 'kimi', sessionId: 'session-b' }
      )
    )
  })

  it('shows nothing, and asks nothing, until the provider names its session', async () => {
    status(null)
    const { result } = renderHook(() => useSessionWrittenFiles(session, true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(result.current).toEqual([])
    expect(mocks.list).not.toHaveBeenCalled()
  })

  it('reads a restored session by the identity its row resolved when nothing is live', async () => {
    const restored = {
      ...session,
      agent: 'claude-agent-teams',
      providerSession: { key: 'session_id', id: 'session-b' }
    } as SidebarSession
    const { result } = renderHook(() => useSessionWrittenFiles(restored, true))
    await waitFor(() => expect(result.current).toEqual(['/w/b.md']))
    expect(mocks.list).toHaveBeenCalledWith(
      { kind: 'local' },
      { provider: 'claude', sessionId: 'session-b' }
    )
  })

  it('never lets a live entry, with or without identity, borrow the row’s saved session', async () => {
    const saved = {
      ...session,
      agent: 'kimi',
      providerSession: { key: 'session_id', id: 'session-saved' }
    } as SidebarSession
    status(null)
    const { rerender } = renderHook(() => useSessionWrittenFiles(saved, true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mocks.list).not.toHaveBeenCalled()
    status('session-b')
    rerender()
    await waitFor(() =>
      expect(mocks.list).toHaveBeenCalledWith(
        { kind: 'local' },
        { provider: 'kimi', sessionId: 'session-b' }
      )
    )
    expect(mocks.list.mock.calls.map(([, read]) => read.sessionId)).not.toContain('session-saved')
  })
})
