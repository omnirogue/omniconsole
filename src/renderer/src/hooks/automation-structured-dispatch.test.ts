import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation, AutomationRun } from '../../../shared/automations-types'
import { makeAutomation } from './automation-dispatch-observer-test-probe'
import { handleAutomationDispatchRequest } from './automation-dispatch-handler'

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  submit: vi.fn(),
  markDispatchResult: vi.fn(),
  releaseReuseTab: undefined as (() => void) | undefined,
  worktree: { id: 'worktree-1', displayName: 'Routine workspace' }
}))

vi.mock('@/lib/automation-workspace-hub-authority', () => ({
  assertAutomationWorkspaceAuthority: vi.fn()
}))
vi.mock('@/lib/automation-reused-session-input', () => ({
  sendAutomationSessionInput: vi.fn()
}))
vi.mock('@/components/automations/automation-host-client', () => ({
  listAutomationRunsForTarget: vi.fn().mockResolvedValue([])
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/lib/agent-paste-draft', () => ({ submitPromptToAgentPty: mocks.submit }))
vi.mock('@/lib/automation-thread-resume-launch', () => ({
  launchAutomationAgentSession: mocks.launch
}))
vi.mock('@/lib/automation-session-observer', () => ({
  observeExistingAutomationSession: vi.fn().mockResolvedValue(() => {})
}))
vi.mock('@/lib/automation-session-reuse', () => ({
  findReusableAutomationSession: () => ({
    tabId: 'reused-tab',
    paneKey: 'reused-pane',
    ptyId: 'reused-pty'
  })
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      activeView: 'terminal',
      activeWorktreeId: null,
      activeTabId: null,
      activeTabType: 'terminal'
    })
  }
}))
vi.mock('./automation-dispatch-workspace', () => ({
  resolveAutomationDispatchWorkspace: () => ({
    repo: { id: 'repo-1' },
    context: {
      workspaceId: 'worktree-1',
      workspaceDisplayName: 'Routine workspace',
      precheckResult: null
    }
  }),
  prepareAutomationDispatchWorkspace: vi.fn().mockResolvedValue(mocks.worktree)
}))
vi.mock('./automation-dispatch-completion', () => ({
  createAutomationDispatchCompletion: () => ({
    setReuseDispatchTabRelease: (release: () => void) => {
      mocks.releaseReuseTab = release
    },
    cleanupRunObservers: vi.fn(),
    handleAgentDone: vi.fn(),
    appendOutput: vi.fn(),
    captureAssistantMessage: vi.fn(),
    handleExit: vi.fn(),
    setSessionObserver: vi.fn(),
    observeAgentStatus: vi.fn(),
    settlePendingAfterDispatch: vi.fn().mockResolvedValue(undefined),
    setThreadResume: vi.fn(),
    providerSessionFields: () => ({})
  })
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.submit.mockResolvedValue(true)
  mocks.launch.mockResolvedValue({
    result: {
      tabId: 'fresh-tab',
      paneKey: 'fresh-pane',
      ptyId: 'fresh-pty',
      terminalOwnership: { release: vi.fn(), finalize: vi.fn().mockReturnValue(true) }
    }
  })
  mocks.markDispatchResult.mockResolvedValue(undefined)
  vi.stubGlobal('window', {
    api: { automations: { markDispatchResult: mocks.markDispatchResult } }
  })
})
afterEach(() => {
  mocks.releaseReuseTab?.()
  mocks.releaseReuseTab = undefined
  vi.unstubAllGlobals()
})

describe.each([
  [false, undefined],
  [true, undefined],
  [false, 'classification.v1'],
  [true, 'classification.v1'],
  [false, 'advertising.v1'],
  [true, 'advertising.v1']
] as const)('routine prompt dispatch with reuse=%s and contract=%s', (reuseSession, contract) => {
  it.each([undefined, '  Check the latest evidence.\n'])(
    'delivers the selected prompt without changing saved content (override=%j)',
    async (promptOverride) => {
      const structuredOutput =
        contract === 'advertising.v1'
          ? {
              provider: 'typesafe',
              contract,
              advertising: { company: 'betacorp', accountId: 'act_123456789' }
            }
          : contract
            ? { provider: 'typesafe', contract }
            : undefined
      const automation = Object.freeze(
        makeAutomation({
          reuseSession,
          structuredOutput,
          contextPaths: ['docs/run-evidence.md'],
          outputFormat: 'json'
        }) as Automation
      )
      const run = Object.freeze({
        id: 'run-1',
        automationId: automation.id,
        title: 'Routine run',
        promptOverride,
        trigger: 'scheduled',
        workspaceId: null,
        workspaceDisplayName: null
      } as AutomationRun)
      const original = structuredClone({ automation, run })

      await handleAutomationDispatchRequest({ automation, run, dispatchToken: 'dispatch-token' })

      const submitted = reuseSession
        ? mocks.submit.mock.calls[0]?.[0]?.content
        : mocks.launch.mock.calls[0]?.[0]?.launch.prompt
      const selectedPrompt = promptOverride ?? automation.prompt
      const [definitionContext, submittedPrompt] = submitted.split(
        '\nEnd routine definition context.\n\n'
      )
      expect(definitionContext).toMatch(/^Routine definition context:\n/)
      expect(definitionContext).toContain('docs/run-evidence.md')
      expect(definitionContext).toContain('Required output format: json')
      expect(definitionContext).toContain('"notable": boolean')
      if (contract) {
        expect(submittedPrompt.startsWith(`${selectedPrompt}\n\n`)).toBe(true)
        expect(submittedPrompt).toContain(
          contract === 'advertising.v1' ? 'omni-advertising-candidates' : 'INCONCLUSIVE'
        )
        if (contract === 'advertising.v1') {
          expect(submittedPrompt).toContain('company betacorp and account act_123456789')
        }
      } else {
        expect(submittedPrompt).toBe(selectedPrompt)
      }
      expect({ automation, run }).toEqual(original)
      expect(mocks.markDispatchResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          runId: 'run-1',
          status: 'dispatched',
          terminalSessionId: reuseSession ? 'reused-tab' : 'fresh-tab'
        })
      )
      if (reuseSession) {
        expect(mocks.submit).toHaveBeenCalledTimes(1)
        expect(mocks.launch).not.toHaveBeenCalled()
      } else {
        expect(mocks.launch).toHaveBeenCalledTimes(1)
        expect(mocks.submit).not.toHaveBeenCalled()
      }
    }
  )
})
