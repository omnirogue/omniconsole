import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useFullSubmitPreparation } from './full-submit-preparation'
import { prependHubTaskPrompt } from '../../../../shared/omnios-task-binding'
import { tokenizeCustomCommandTemplate } from '../../../../shared/commit-message-prompt'

vi.mock('react', () => ({ useCallback: (callback: unknown) => callback }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/ensure-hooks-confirmed', () => ({
  ensureHooksConfirmed: vi.fn(),
  confirmRuntimeIssueCommandRead: vi.fn()
}))

describe('full composer hub launch binding', () => {
  it.each([undefined, 'low'])(
    'preserves card binding and explicit effort env=%s',
    async (effort) => {
      const input = {
        branchAutoNameRef: { current: '' },
        branchNameOverridePreservesNameEdits: false,
        isSubmissionCancelled: () => false,
        name: 'customer-reply',
        repoId: 'folder-repo',
        selectedRepo: {},
        selectedRepoIsGit: false,
        selectedRepoIsRemote: false,
        selectedRepoAgentLaunchPlatform: 'darwin',
        telemetrySource: 'sidebar',
        tuiAgent: 'claude',
        settings: {
          ...getDefaultSettings('/tmp'),
          experimentalNativeChat: true,
          openAgentTabsInChatByDefault: false,
          nativeChatSessionOptions: {
            claude: { model: 'opus', valuesByModel: { opus: { effort: 'medium' } } }
          },
          agentDefaultEnv: {
            claude: {
              OMNI_TASK_ID: 'btk_wrong',
              CUSTOM: 'preserved',
              ...(effort ? { CLAUDE_CODE_EFFORT_LEVEL: effort } : {})
            }
          }
        },
        prepareFullSubmitSource: () => ({
          submitLinkedWorkItem: { hubTaskId: 'btk_1234' },
          submitTitleName: null,
          nameIsAutoManaged: false,
          smartGitHubCreateNames: { workspaceName: 'customer-reply' },
          workspaceName: 'customer-reply',
          submitBranchNameOverride: undefined,
          submitLinkedWorkItemProvider: 'backoffice',
          submitStartupPrompt: 'Draft the customer reply',
          submitShouldRunIssueAutomation: false
        })
      } as unknown as Parameters<typeof useFullSubmitPreparation>[0]

      const result = await useFullSubmitPreparation(input).prepareFullSubmit({ kind: 'none' })

      expect(result?.submitStartupPrompt).toBe(
        prependHubTaskPrompt('Draft the customer reply', 'btk_1234')
      )
      const command = tokenizeCustomCommandTemplate(result?.startupPlan?.launchCommand ?? '')
      expect(command.ok && command.tokens.at(-1)).toContain(result?.submitStartupPrompt)
      expect(result?.startupPlan?.launchCommand).not.toContain('omni outcome context --json')
      expect(result?.backendStartup?.env).toMatchObject({
        OMNI_TASK_ID: 'btk_1234',
        CUSTOM: 'preserved'
      })
      expect(result?.startupPlan?.launchConfig.agentEnv).toMatchObject({ OMNI_TASK_ID: 'btk_1234' })
      if (effort) {
        expect(result?.startupPlan?.env).toMatchObject({ CLAUDE_CODE_EFFORT_LEVEL: effort })
        expect(result?.startupPlan?.sessionOptions).toBeUndefined()
        expect(result?.startupPlan?.launchCommand).not.toContain('--effort')
      } else {
        expect(result?.startupPlan?.sessionOptions).toEqual({ effort: 'medium' })
        expect(result?.startupPlan?.launchCommand).toContain("'--effort' 'medium'")
      }
    }
  )
})
