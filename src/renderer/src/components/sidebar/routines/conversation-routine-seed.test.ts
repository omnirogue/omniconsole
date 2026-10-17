import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import { buildSidebarSessions } from '@/lib/sidebar-sessions'
import { conversationRoutineSeed } from './conversation-routine-seed'

vi.mock('@/lib/sidebar-sessions', () => ({ buildSidebarSessions: vi.fn() }))

describe('conversation routine source', () => {
  const setup = (hostId = 'local', folder = false) => {
    vi.mocked(buildSidebarSessions).mockReturnValue([
      {
        sessionKey: 'source',
        rowKey: 'row',
        worktreeId: 'workspace',
        paneKey: 'pane',
        tabId: 'tab',
        hostId,
        agent: 'codex',
        label: 'Daily check'
      }
    ] as never)
    return {
      getKnownWorktreeById: vi.fn(() => ({ repoId: folder ? undefined : 'repo' })),
      repos: [{ id: 'repo', connectionId: hostId === 'local' ? null : 'build' }],
      activeRepoId: 'unrelated',
      agentStatusByPaneKey: {
        pane: {
          stateHistory: [{ prompt: 'Original task' }],
          prompt: 'Continue',
          lastCompletedAssistantMessage: 'Prior result'
        }
      },
      sleepingAgentSessionsByPaneKey: {},
      nativeChatLaunchPromptByTabId: {}
    } as unknown as AppState
  }
  it.each([false, true])(
    'retains the original task and outcome in a %s folder workspace',
    (folder) => {
      const state = setup('local', folder)
      expect(conversationRoutineSeed(state, 'source')).toMatchObject({
        workspaceId: 'workspace',
        projectId: 'repo',
        hostId: 'local',
        agentId: 'codex',
        cron: '0 9 * * *',
        prompt: 'Original task\n\nPrevious result for context:\nPrior result'
      })
    }
  )
  it('keeps a remote conversation on its owning computer', () => {
    const state = setup('ssh:build', true)
    expect(conversationRoutineSeed(state, 'source')).toMatchObject({
      hostId: 'ssh:build',
      projectId: 'repo'
    })
    expect(state.getKnownWorktreeById).toHaveBeenCalledWith('workspace', 'ssh:build')
  })
  it('refuses an unavailable source rather than guessing a different computer', () => {
    const state = setup()
    vi.mocked(buildSidebarSessions).mockReturnValue([
      { sessionKey: 'source', unavailable: true }
    ] as never)
    expect(conversationRoutineSeed(state, 'source')).toBeNull()
    expect(state.getKnownWorktreeById).not.toHaveBeenCalled()
  })
})
