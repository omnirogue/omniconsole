import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useFolderSubmitOrchestration } from './folder-submit-orchestration'

const mocks = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('react', () => ({ useCallback: (callback: unknown) => callback }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/components/sidebar/folder-workspace-composer-submit', () => ({
  getFolderWorkspaceAgentLaunchPlatform: () => 'darwin',
  resolveFolderWorkspaceLaunchDraft: vi.fn(),
  submitFolderWorkspaceCreate: mocks.create
}))

function input(settings = getDefaultSettings('/tmp')) {
  return {
    settings,
    selectedProjectGroup: { id: 'group', name: 'Team', parentPath: '/work', connectionId: null },
    folderCreateDisabled: false,
    folderSourceRepos: [],
    folderTargetConnectionId: null,
    folderTargetIsRemote: false,
    folderTargetRuntimeEnvironmentId: null,
    disabledTuiAgents: [],
    decisions: { canResolveFolderSmartGitHubSubmit: () => false },
    resolvePendingSmartGitHubSubmit: vi.fn(),
    isSubmissionCancelled: () => false,
    linkedWorkItem: null,
    name: 'Review',
    note: 'Review changes',
    lastAutoNameRef: { current: '' },
    taskSourceContext: null,
    telemetrySource: 'sidebar',
    persistDraft: false,
    clearNewWorkspaceDraft: vi.fn(),
    createFolderWorkspace: vi.fn(),
    onCreated: vi.fn(),
    setCreateError: vi.fn(),
    setCreating: vi.fn()
  } as unknown as Parameters<typeof useFolderSubmitOrchestration>[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.create.mockResolvedValue(true)
})

describe('folder submit terminal effort defaults', () => {
  it.each(['saved', 'profile', 'custom'] as const)(
    'preserves terminal choices when the selection is %s',
    async (selection) => {
      const settings = {
        ...getDefaultSettings('/tmp'),
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: false,
        nativeChatSessionOptions: {
          codex: {
            model: 'gpt-5.2-codex',
            valuesByModel: { 'gpt-5.2-codex': { effort: 'medium' } }
          }
        }
      }
      if (selection === 'profile') {
        settings.agentDefaultArgs = { codex: '--profile work' }
      }
      if (selection === 'custom') {
        settings.agentCmdOverrides = { codex: 'custom-codex' }
      }
      await useFolderSubmitOrchestration(input(settings)).submitFolderTarget('codex')
      expect(mocks.create).toHaveBeenCalledOnce()
      const launch = mocks.create.mock.calls[0]?.[0]
      expect(launch.sessionOptions).toEqual(
        selection === 'saved' ? { effort: 'medium' } : undefined
      )
      if (selection === 'profile') {
        expect(launch.agentArgs).toBe('--profile work')
      }
      if (selection === 'custom') {
        expect(launch.agentCmdOverrides).toEqual({ codex: 'custom-codex' })
      }
    }
  )
})
