import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomationLaunchUnverifiableError } from '../../../shared/automation-launch-outcome'
import { makeAutomation, makeRun } from '@/components/automations/automations-page-fixtures'
import { handleAutomationDispatchRequest } from './automation-dispatch-handler'

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  markDispatchResult: vi.fn(),
  observeAgentStatus: vi.fn(),
  release: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/automation-workspace-hub-authority', () => ({
  assertAutomationWorkspaceAuthority: vi.fn()
}))
vi.mock('@/lib/automation-thread-resume-launch', () => ({
  launchAutomationAgentSession: mocks.launch
}))
vi.mock('./automation-dispatch-workspace', () => ({
  resolveAutomationDispatchWorkspace: () => ({
    repo: { id: 'repo-1' },
    context: { workspaceId: 'worktree-1', workspaceDisplayName: 'Routine workspace' }
  }),
  prepareAutomationDispatchWorkspace: async () => ({
    id: 'worktree-1',
    displayName: 'Routine workspace'
  })
}))
vi.mock('./automation-dispatch-completion', () => ({
  createAutomationDispatchCompletion: () => ({
    setThreadResume: vi.fn(),
    observeAgentStatus: mocks.observeAgentStatus,
    providerSessionFields: () => ({}),
    settlePendingAfterDispatch: async () => {},
    cleanupRunObservers: vi.fn()
  })
}))

const binding = {
  tabId: 'routine-tab',
  paneKey: 'routine-pane',
  ptyId: 'routine-pty',
  terminalOwnership: { release: mocks.release, finalize: vi.fn() }
}
const dispatch = () =>
  handleAutomationDispatchRequest({
    automation: makeAutomation({ reuseSession: false }),
    run: makeRun({ status: 'dispatching' }),
    dispatchToken: 'dispatch-token'
  })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.launch.mockResolvedValue({ result: binding, resume: null })
  mocks.markDispatchResult.mockResolvedValue(undefined)
  vi.stubGlobal('window', {
    api: { automations: { markDispatchResult: mocks.markDispatchResult } }
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('routine launch uncertainty', () => {
  it('keeps an unconfirmed create active instead of allowing the next occurrence to launch', async () => {
    mocks.launch.mockRejectedValueOnce(
      new AutomationLaunchUnverifiableError(new Error('spawn receipt lost'))
    )
    await dispatch()

    expect(mocks.markDispatchResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        status: 'dispatching',
        launchOutcome: 'unverifiable',
        error: 'spawn receipt lost'
      })
    )
    expect(mocks.launch).toHaveBeenCalledTimes(1)
  })

  it('records a pre-spawn refusal as an ordinary failure', async () => {
    mocks.launch.mockRejectedValueOnce(new Error('workspace authority changed'))
    await dispatch()

    expect(mocks.markDispatchResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: 'dispatch_failed', error: 'workspace authority changed' })
    )
    expect(mocks.markDispatchResult.mock.calls[0][0]).not.toHaveProperty('launchOutcome')
  })

  it.each(['observer setup', 'dispatch receipt', 'prompt delivery'])(
    'retains the known worker for completion observation after %s fails',
    async (stage) => {
      if (stage === 'observer setup') {
        mocks.observeAgentStatus.mockImplementationOnce(() => {
          throw new Error('observer failed')
        })
      } else if (stage === 'dispatch receipt') {
        mocks.markDispatchResult.mockRejectedValueOnce(new Error('dispatch receipt lost'))
      } else {
        mocks.launch.mockResolvedValueOnce({
          result: { ...binding, promptDeliveryResult: Promise.resolve(false) },
          resume: null
        })
      }
      await dispatch()

      expect(mocks.markDispatchResult).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: 'dispatched',
          launchOutcome: 'unverifiable',
          workspaceId: 'worktree-1',
          terminalSessionId: 'routine-tab',
          terminalPaneKey: 'routine-pane',
          terminalPtyId: 'routine-pty'
        })
      )
      expect(mocks.release).toHaveBeenCalled()
      expect(mocks.launch).toHaveBeenCalledTimes(1)
    }
  )
})
