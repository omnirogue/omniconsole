import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeSessionChains, type SessionChain } from '../../../shared/session-chain-types'
import type { SessionFollowUpExceptionCode } from '../../../shared/session-follow-up-rule'

const client = vi.hoisted(() => ({
  listSessionChainsFromHost: vi.fn(),
  upsertSessionChainOnHost: vi.fn(),
  removeSessionChainOnHost: vi.fn(),
  listSessionChainOutputFilesFromHost: vi.fn(),
  readTerminalTailFromHost: vi.fn()
}))
const step = vi.hoisted(() => ({ runSessionFollowUpStep: vi.fn() }))
const store = vi.hoisted(() => {
  const state = {
    settings: {},
    activeWorktreeId: 'folder:f1',
    workspaceSessionReady: true,
    terminalStartupRestorationReady: true,
    terminalLayoutsByTabId: {},
    agentStatusByPaneKey: {},
    getKnownWorktreeById: () => ({ path: '/w' })
  }
  return { state, getState: () => state, subscribe: () => () => undefined }
})

vi.mock('@/lib/session-chain-client', () => client)
vi.mock('@/lib/session-follow-up-step', () => step)
vi.mock('@/lib/launch-agent-session-continuation', () => ({
  launchAgentSessionContinuation: vi.fn()
}))
vi.mock('@/lib/next-session-launch', () => ({
  createTerminalWaitDependencies: vi.fn(),
  waitForSourceSessionCompletion: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorkspace: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (s: unknown) => unknown) => selector(store.state), {
    getState: store.getState,
    subscribe: store.subscribe
  })
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getSettingsForWorktreeRuntimeOwner: () => ({ activeRuntimeEnvironmentId: null })
}))
vi.mock('@/components/terminal-pane/terminal-layout-leaf-ids', () => ({
  collectLeafIdsInOrder: () => [],
  resolveRootlessTerminalLayoutLeafId: () => null
}))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))

const DAY_MS = 24 * 60 * 60 * 1000

function followUp(
  id: string,
  state: SessionChain['state'],
  code?: SessionFollowUpExceptionCode,
  updatedAt = Date.now()
): unknown {
  return {
    id,
    workspacePath: '/w',
    worktreeId: 'folder:f1',
    hostId: 'local',
    sourcePaneKey: 'tab-src:leaf-1',
    sourceRowKey: `row-${id}`,
    auto: true,
    steps: [
      {
        kind: 'handoff',
        id: `step_${id}`,
        status: 'queued',
        handoff: {
          revision: 1,
          taskId: 'btk_abcd1234',
          taskTitle: 'Webinar intro',
          sessionLabel: 'Draft',
          recipients: [
            {
              employeeId: 'emp_iris',
              name: 'Iris',
              operationId: 'fu_iris_key',
              delivery: 'pending'
            }
          ],
          action: 'review',
          deliverables: { kind: 'files', paths: ['/w/report.md'] },
          includeSummary: false,
          note: 'Please review',
          savedAt: 1,
          ...(code ? { exception: { code, subject: '', detail: '', at: 2 } } : {})
        }
      }
    ],
    currentIndex: 0,
    state,
    createdAt: 1,
    updatedAt
  }
}

describe('session chain runner: saved follow-ups after a restart', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    client.upsertSessionChainOnHost.mockImplementation(async (_target, chain) => chain)
    client.removeSessionChainOnHost.mockResolvedValue(undefined)
    // Why: a resolved step would re-enter the runner loop; a pending one stands for a live wait.
    step.runSessionFollowUpStep.mockImplementation(() => new Promise(() => {}))
  })

  it('resumes waiting, mid-delivery and unverifiable follow-ups and keeps the rest as records', async () => {
    const runner = await import('./session-chain-runner')
    runner.resetSessionChainsForTests()
    client.listSessionChainsFromHost.mockResolvedValue(
      normalizeSessionChains([
        followUp('waiting', 'waiting'),
        followUp('launching', 'launching'),
        followUp('offline', 'failed', 'host-unreachable'),
        followUp('unverified', 'failed', 'unverifiable'),
        followUp('broken', 'failed', 'run-failed'),
        followUp('sent', 'done'),
        followUp('cancelled', 'cancelled'),
        followUp('old', 'done', undefined, Date.now() - 8 * DAY_MS)
      ])
    )

    await runner.loadSessionChains()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const resumed = step.runSessionFollowUpStep.mock.calls
      .map(([access]) => (access as { getChain: () => SessionChain | null }).getChain()?.id)
      .sort()
    expect(resumed).toEqual(['launching', 'offline', 'unverified', 'waiting'])
    expect(
      step.runSessionFollowUpStep.mock.calls.every(
        ([, paneKeys]) => (paneKeys as string[])[0] === 'tab-src:leaf-1'
      )
    ).toBe(true)
    // A chain persisted mid-delivery comes back waiting; its captured state replays delivery.
    expect(runner.getSessionChain('launching')?.state).toBe('waiting')
    for (const id of ['broken', 'sent', 'cancelled']) {
      expect(runner.getSessionChain(id)).not.toBeNull()
    }
    expect(runner.getSessionChain('old')).toBeNull()
    expect(client.removeSessionChainOnHost).toHaveBeenCalledTimes(1)
    expect(client.removeSessionChainOnHost).toHaveBeenCalledWith({ kind: 'local' }, 'old')
    runner.resetSessionChainsForTests()
  })
})
