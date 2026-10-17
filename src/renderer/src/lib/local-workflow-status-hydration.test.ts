import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalWorkflowChangedEvent } from '../../../shared/local-workflow-rpc'
import type { SshConnectionState } from '../../../shared/ssh-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { LocalWorkflowHydrationOutcome } from '@/store/slices/local-workflow-status'
import { evolveRunFixture } from '../components/evolve/evolve-run.fixtures'
import {
  LOCAL_WORKFLOW_HYDRATION_REARM_MS,
  LOCAL_WORKFLOW_HYDRATION_RETRY_MS,
  installLocalWorkflowStatusHydration
} from './local-workflow-status-hydration'

type FakeState = {
  tabsByWorktree: Record<string, TerminalTab[]>
  localWorkflowStatusByTabId: Record<string, LocalWorkflowChangedEvent>
  localWorkflowHydrationByTabId: Record<string, LocalWorkflowHydrationOutcome>
  localWorkflowHydrationRefresh: { count: number; tabId: string | null }
  sshConnectionStates: Map<string, Pick<SshConnectionState, 'targetId' | 'status'>>
  workspaceSessionReady: boolean
  setLocalWorkflowStatus: (status: LocalWorkflowChangedEvent) => void
  setLocalWorkflowHydration: (tabId: string, outcome: LocalWorkflowHydrationOutcome | null) => void
  buildReview: {
    pipelinesById: Record<string, unknown>
    pipelinesListed: boolean
    error: string | null
    refreshAll: () => Promise<boolean>
  }
}

const fake = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const store = {
    state: undefined as unknown,
    getState: () => store.state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (patch: Record<string, unknown>) => {
      store.state = { ...(store.state as object), ...patch }
      listeners.forEach((listener) => listener())
    },
    listeners
  }
  return { store, rpc: vi.fn(), refreshAll: vi.fn() }
})

vi.mock('@/store', () => ({ useAppStore: fake.store }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: fake.rpc }))

function tab(id: string, localWorkflow: TerminalTab['localWorkflow']): TerminalTab {
  return {
    id,
    worktreeId: 'worktree-1',
    ptyId: null,
    title: 'Workflow',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    localWorkflow
  }
}

function status(executionId: string, state: LocalWorkflowChangedEvent['state']) {
  return {
    conversationId: 'tab-1',
    executionId,
    preset: 'council' as const,
    state,
    running: 0,
    completed: 4,
    total: 4
  }
}

function state(): FakeState {
  return fake.store.state as FakeState
}

const councilTab = () =>
  tab('tab-1', { preset: 'council', prompt: 'Q', executionId: 'execution-1' })

let dispose: (() => void) | undefined

beforeEach(() => {
  fake.refreshAll.mockImplementation(async () => {
    fake.store.set({ buildReview: { ...state().buildReview, pipelinesListed: true } })
    return true
  })
  fake.store.state = {
    tabsByWorktree: {},
    localWorkflowStatusByTabId: {},
    localWorkflowHydrationByTabId: {},
    localWorkflowHydrationRefresh: { count: 0, tabId: null },
    sshConnectionStates: new Map(),
    workspaceSessionReady: true,
    setLocalWorkflowStatus: (next: LocalWorkflowChangedEvent) => {
      const hydration = { ...state().localWorkflowHydrationByTabId }
      delete hydration[next.conversationId]
      fake.store.set({
        localWorkflowStatusByTabId: {
          ...state().localWorkflowStatusByTabId,
          [next.conversationId]: next
        },
        localWorkflowHydrationByTabId: hydration
      })
    },
    setLocalWorkflowHydration: (tabId, outcome) => {
      const hydration = { ...state().localWorkflowHydrationByTabId }
      if (outcome) {
        hydration[tabId] = outcome
      } else {
        delete hydration[tabId]
      }
      fake.store.set({ localWorkflowHydrationByTabId: hydration })
    },
    buildReview: {
      pipelinesById: {},
      pipelinesListed: false,
      error: null,
      refreshAll: fake.refreshAll
    }
  } satisfies FakeState
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  fake.store.listeners.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

async function exhaustRetries(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  for (let index = 0; index < 5; index++) {
    await vi.advanceTimersByTimeAsync(LOCAL_WORKFLOW_HYDRATION_RETRY_MS)
  }
}

describe('workflow status hydration after a restart', () => {
  it('reads each started run once and never recovers or reads drafts', async () => {
    fake.rpc.mockResolvedValue(status('execution-1', 'completed'))
    fake.store.set({
      tabsByWorktree: {
        'worktree-1': [councilTab(), tab('tab-2', { preset: 'discover', prompt: '' })]
      }
    })
    dispose = installLocalWorkflowStatusHydration()
    await vi.waitFor(() =>
      expect(state().localWorkflowStatusByTabId['tab-1']?.state).toBe('completed')
    )
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(fake.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'localWorkflow.status', {
      worktree: 'id:worktree-1',
      conversationId: 'tab-1',
      executionId: 'execution-1'
    })
    fake.store.set({ tabsByWorktree: { ...state().tabsByWorktree } })
    expect(fake.rpc).toHaveBeenCalledTimes(1)
  })

  it('keeps a status pushed while the read was in flight', async () => {
    let answer!: (value: unknown) => void
    fake.rpc.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      })
    )
    fake.store.set({ tabsByWorktree: { 'worktree-1': [councilTab()] } })
    dispose = installLocalWorkflowStatusHydration()
    state().setLocalWorkflowStatus(status('execution-1', 'running'))
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    answer(status('execution-1', 'paused'))
    // A macrotask later every continuation of the read has run.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(state().localWorkflowStatusByTabId['tab-1']?.state).toBe('running')
  })

  // Why (C6): the run belongs to the controller that started it, not the workspace's host.
  it('reads from the controller that owns the run, whatever host runs the workspace', async () => {
    fake.rpc.mockResolvedValue(status('execution-1', 'completed'))
    fake.store.set({
      sshConnectionStates: new Map([['ssh-1', { targetId: 'ssh-1', status: 'disconnected' }]]),
      tabsByWorktree: { 'ssh-repo::/remote/project': [councilTab()] }
    })
    dispose = installLocalWorkflowStatusHydration()
    await vi.waitFor(() => expect(fake.rpc).toHaveBeenCalledTimes(1))
    expect(fake.rpc.mock.calls[0]![0]).toEqual({ kind: 'local' })
    expect(fake.rpc.mock.calls[0]![2]).toMatchObject({ worktree: 'id:ssh-repo::/remote/project' })
  })

  it('retries a failed read later, a bounded number of times, and says status unavailable', async () => {
    vi.useFakeTimers()
    fake.rpc.mockRejectedValue(new Error('Runtime is starting'))
    fake.store.set({ tabsByWorktree: { 'worktree-1': [councilTab()] } })
    dispose = installLocalWorkflowStatusHydration()
    await exhaustRetries()
    expect(fake.rpc).toHaveBeenCalledTimes(3)
    expect(state().localWorkflowHydrationByTabId['tab-1']).toEqual({
      runId: 'execution-1',
      outcome: 'failed',
      attempts: 3,
      reason: 'Runtime is starting'
    })
  })

  it('stores an empty answer as a failed read and retries it, never as a status', async () => {
    vi.useFakeTimers()
    fake.rpc.mockResolvedValueOnce(null).mockResolvedValue(status('execution-1', 'running'))
    fake.store.set({ tabsByWorktree: { 'worktree-1': [councilTab()] } })
    dispose = installLocalWorkflowStatusHydration()
    await vi.advanceTimersByTimeAsync(0)
    expect(state().localWorkflowHydrationByTabId['tab-1']?.outcome).toBe('failed')
    await vi.advanceTimersByTimeAsync(LOCAL_WORKFLOW_HYDRATION_RETRY_MS)
    expect(state().localWorkflowStatusByTabId['tab-1']?.state).toBe('running')
    expect(state().localWorkflowHydrationByTabId['tab-1']).toBeUndefined()
  })

  it('stores the controller’s not-found answer as run not found and does not retry it', async () => {
    vi.useFakeTimers()
    fake.rpc.mockRejectedValue(
      new Error("Error invoking remote method 'runtime:call': Error: Workflow was not found")
    )
    fake.store.set({ tabsByWorktree: { 'worktree-1': [councilTab()] } })
    dispose = installLocalWorkflowStatusHydration()
    await exhaustRetries()
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    expect(state().localWorkflowHydrationByTabId['tab-1']).toMatchObject({
      runId: 'execution-1',
      outcome: 'missing'
    })

    // "Check status again" on the row asks the controller once more; the run is back.
    fake.rpc.mockResolvedValue(status('execution-1', 'completed'))
    fake.store.set({ localWorkflowHydrationRefresh: { count: 1, tabId: 'tab-1' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.rpc).toHaveBeenCalledTimes(2)
    expect(state().localWorkflowStatusByTabId['tab-1']?.state).toBe('completed')
    expect(state().localWorkflowHydrationByTabId['tab-1']).toBeUndefined()
  })

  // Why: one run's retry timer used to re-read every failed run, so later runs spent their three
  // tries within a single retry interval.
  it('spaces each run’s retries on its own clock when several runs fail', async () => {
    vi.useFakeTimers()
    fake.rpc.mockRejectedValue(new Error('Runtime is starting'))
    const second = tab('tab-2', { preset: 'council', prompt: 'Q', executionId: 'execution-2' })
    fake.store.set({ tabsByWorktree: { 'worktree-1': [councilTab()] } })
    dispose = installLocalWorkflowStatusHydration()
    await vi.advanceTimersByTimeAsync(5_000)
    fake.store.set({ tabsByWorktree: { 'worktree-1': [councilTab(), second] } })
    const readsOf = (executionId: string) =>
      fake.rpc.mock.calls.filter((call) => call[2]?.executionId === executionId).length

    await vi.advanceTimersByTimeAsync(10_000 + 1)
    // The first run's retry (at 15 s) must not read the second run, which failed at 5 s.
    expect([readsOf('execution-1'), readsOf('execution-2')]).toEqual([2, 1])
    await vi.advanceTimersByTimeAsync(5_000)
    expect([readsOf('execution-1'), readsOf('execution-2')]).toEqual([2, 2])
    await vi.advanceTimersByTimeAsync(60_000)
    expect([readsOf('execution-1'), readsOf('execution-2')]).toEqual([3, 3])
    expect(state().localWorkflowHydrationByTabId['tab-2']).toMatchObject({ attempts: 3 })
  })

  it('re-arms only the row the person asked to check again', async () => {
    vi.useFakeTimers()
    fake.rpc.mockRejectedValue(new Error('connect ECONNREFUSED'))
    const second = tab('tab-2', { preset: 'council', prompt: 'Q', executionId: 'execution-2' })
    fake.store.set({ tabsByWorktree: { 'worktree-1': [councilTab(), second] } })
    dispose = installLocalWorkflowStatusHydration()
    await exhaustRetries()
    expect(fake.rpc).toHaveBeenCalledTimes(6)
    fake.store.set({ localWorkflowHydrationRefresh: { count: 1, tabId: 'tab-2' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.rpc).toHaveBeenCalledTimes(7)
    expect(fake.rpc.mock.calls.at(-1)![2]).toMatchObject({ executionId: 'execution-2' })
  })

  it.each([
    [
      'the owner reconnects',
      () =>
        fake.store.set({
          sshConnectionStates: new Map([['ssh-1', { targetId: 'ssh-1', status: 'connected' }]])
        })
    ],
    [
      'the window regains focus',
      () => (globalThis.window as unknown as EventTarget).dispatchEvent(new Event('focus'))
    ],
    [
      'the person asks the row to check again',
      () => fake.store.set({ localWorkflowHydrationRefresh: { count: 1, tabId: 'tab-1' } })
    ]
  ])('shows the real status after exhausted retries once %s', async (_label, rearm) => {
    vi.useFakeTimers()
    const target = Object.assign(new EventTarget(), { document: new EventTarget() })
    vi.stubGlobal('window', target)
    fake.rpc.mockRejectedValue(new Error('connect ECONNREFUSED'))
    fake.store.set({
      sshConnectionStates: new Map([['ssh-1', { targetId: 'ssh-1', status: 'disconnected' }]]),
      tabsByWorktree: { 'worktree-1': [councilTab()] }
    })
    dispose = installLocalWorkflowStatusHydration()
    await exhaustRetries()
    expect(fake.rpc).toHaveBeenCalledTimes(3)
    // An unrelated store write does not re-arm exhausted reads.
    fake.store.set({ tabsByWorktree: { ...state().tabsByWorktree } })
    expect(fake.rpc).toHaveBeenCalledTimes(3)

    fake.rpc.mockResolvedValue(status('execution-1', 'completed'))
    await vi.advanceTimersByTimeAsync(LOCAL_WORKFLOW_HYDRATION_REARM_MS)
    rearm()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.rpc).toHaveBeenCalledTimes(4)
    expect(state().localWorkflowStatusByTabId['tab-1']?.state).toBe('completed')
    expect(state().localWorkflowHydrationByTabId['tab-1']).toBeUndefined()
  })

  it('reads an Evolve run from its record in any workspace, as this tab’s status', async () => {
    const run = evolveRunFixture({ conversationId: 'another-tab' })
    fake.rpc.mockResolvedValue({ run })
    fake.store.set({
      tabsByWorktree: {
        'worktree-1': [tab('tab-1', { preset: 'evolve', prompt: 'Evolve', executionId: run.id })]
      }
    })
    dispose = installLocalWorkflowStatusHydration()
    await vi.waitFor(() =>
      expect(state().localWorkflowStatusByTabId['tab-1']).toMatchObject({
        conversationId: 'tab-1',
        executionId: run.id,
        preset: 'evolve',
        state: 'running'
      })
    )
    expect(fake.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'evolve.show', { id: run.id })
  })

  it('loads Build + Review pipelines once when a restored tab has none', async () => {
    fake.store.set({
      tabsByWorktree: {
        'worktree-1': [
          tab('tab-1', { preset: 'build-review', prompt: 'Fix', buildReviewPipelineId: 'p-1' }),
          tab('tab-2', { preset: 'build-review', prompt: 'Fix', buildReviewPipelineId: 'p-2' })
        ]
      }
    })
    dispose = installLocalWorkflowStatusHydration()
    expect(fake.refreshAll).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(state().buildReview.pipelinesListed).toBe(true))
    fake.store.set({ tabsByWorktree: { ...state().tabsByWorktree } })
    expect(fake.refreshAll).toHaveBeenCalledTimes(1)
    expect(fake.rpc).not.toHaveBeenCalled()
  })

  it('marks Build + Review rows status unavailable when the list fails, and retries it', async () => {
    vi.useFakeTimers()
    fake.refreshAll.mockImplementationOnce(async () => {
      fake.store.set({ buildReview: { ...state().buildReview, error: 'Error: runtime offline' } })
      return false
    })
    fake.store.set({
      tabsByWorktree: {
        'worktree-1': [
          tab('tab-1', { preset: 'build-review', prompt: 'Fix', buildReviewPipelineId: 'p-1' })
        ]
      }
    })
    dispose = installLocalWorkflowStatusHydration()
    await vi.advanceTimersByTimeAsync(0)
    expect(state().localWorkflowHydrationByTabId['tab-1']).toEqual({
      runId: 'p-1',
      outcome: 'failed',
      attempts: 1,
      reason: 'Error: runtime offline'
    })
    await vi.advanceTimersByTimeAsync(LOCAL_WORKFLOW_HYDRATION_RETRY_MS)
    expect(fake.refreshAll).toHaveBeenCalledTimes(2)
    expect(state().buildReview.pipelinesListed).toBe(true)
    expect(state().localWorkflowHydrationByTabId['tab-1']).toBeUndefined()
  })
})
