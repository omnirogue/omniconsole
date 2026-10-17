import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../ipc/filesystem', () => ({
  resolveModelDiscoveryLocalPath: vi.fn(async (_store: unknown, path: string) => path)
}))
vi.mock('../ipc/local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: vi.fn(() => ({}))
}))
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: vi.fn(),
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'SSH is not connected.'
}))
vi.mock('../text-generation/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: vi.fn(async () => ({ ok: true }))
}))

import { getDefaultPersistedState } from '../../shared/constants'
import { conversationSourceRowKey } from '../../shared/conversation-source'
import { normalizeNextStepSuggestionSettings } from '../../shared/next-step-suggestion-settings'
import { updateSettings } from '../persistence/applying-settings/settings-update'
import { generateNextSteps, type NextStepGeneratorDeps } from './next-step-suggestion-generator'
import { NextStepSuggestionService } from './next-step-suggestion-service'
import { NextStepSuggestionStore } from './next-step-suggestion-store'

describe('the settings section reaches the suggester', () => {
  it('carries enabled, agent and model from a settings write to the service and the runner call', async ({
    onTestFinished
  }) => {
    const state = getDefaultPersistedState('/home/me')
    const operations = {
      state,
      bumpLocalWorktreeScanGeneration: vi.fn(),
      removeRetainedBlob: vi.fn(),
      scheduleSave: vi.fn(),
      notifySettingsChanged: vi.fn()
    }
    // What the settings section sends.
    updateSettings(operations, {
      nextStepSuggestions: { enabled: false, agent: 'codex', model: 'gpt-5.4' }
    })
    // What the wiring reads on every turn.
    const settings = () => normalizeNextStepSuggestionSettings(state.settings.nextStepSuggestions)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const directory = mkdtempSync(join(tmpdir(), 'next-step-settings-'))
    const store = new NextStepSuggestionStore({ directory })
    const service = new NextStepSuggestionService({
      store,
      settings,
      readPromptQueue: () => null,
      isChainBound: () => false,
      enqueue: vi.fn(),
      generate: vi.fn(async () => ({ ok: false as const, error: 'not under test' }))
    })
    const conversation = {
      worktreeId: 'repo::/work/app',
      paneKey: 'tab:leaf',
      kind: 'pty' as const
    }
    onTestFinished(async () => {
      service.scheduler.abort(conversationSourceRowKey(conversation), 'test done')
      try {
        // The aborted job can still update its set; settle it before draining persistence.
        await vi.waitFor(() => expect(service.scheduler.runningCount).toBe(0))
        await store.flush()
        expect(store.storageError).toBeUndefined()
      } finally {
        info.mockRestore()
        rmSync(directory, { recursive: true, force: true })
      }
    })
    const turn = { conversation, turnKey: 't', agent: 'claude', lastAssistantMessage: 'Done.' }
    expect(service.onFinishedTurn(turn)).toEqual({
      set: null,
      skipped: 'Suggested next steps are turned off in settings.'
    })

    // The runner is called with the chosen CLI and model, not the conversation's own agent.
    const generateText = vi.fn(async () => ({
      success: true as const,
      rawOutput: JSON.stringify({
        suggestions: [
          { title: 'Run tests', prompt: 'Run the tests.', risk: 'safe', kind: 'verify' }
        ]
      }),
      agentLabel: 'Codex'
    }))
    const deps: NextStepGeneratorDeps = {
      store: {
        getRepo: (id: string) =>
          id === 'repo' ? { id: 'repo', kind: 'git', connectionId: null } : undefined,
        getFolderWorkspaces: () => [],
        getSettings: () => ({ agentCmdOverrides: {} })
      } as unknown as NextStepGeneratorDeps['store'],
      settings,
      readGitStatus: vi.fn(async () => ({
        entries: [],
        conflictOperation: 'unknown' as const,
        branch: 'main'
      })),
      generateText: generateText as unknown as NextStepGeneratorDeps['generateText']
    }
    // Turning it back on reaches the service too: the next turn is scheduled, not skipped.
    updateSettings(operations, {
      nextStepSuggestions: { enabled: true, agent: 'codex', model: 'gpt-5.4' }
    })
    expect(
      service.onFinishedTurn({ ...turn, turnKey: 't2' }, { immediate: true })
    ).not.toMatchObject({ skipped: expect.anything() })
    service.scheduler.abort(conversationSourceRowKey(conversation), 'test done')
    const outcome = await generateNextSteps(deps, turn, new AbortController().signal)
    expect(outcome).toMatchObject({ ok: true })
    expect(generateText).toHaveBeenCalledWith(
      expect.any(String),
      { agentId: 'codex', model: 'gpt-5.4' },
      expect.anything()
    )
  })
})
