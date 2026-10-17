import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeAttempt } from '../../shared/session-outcome-types'

const external = vi.hoisted(() => ({
  coordinator: vi.fn(async (_runtime, _worktree, _title, opts) => opts.preAllocatedHandle),
  call: vi.fn(async (method: string) => {
    if (method === 'orchestration.runCreate') {
      return { run: { id: 'run_1', hub_task_id: null } }
    }
    if (method === 'orchestration.taskCreate') {
      return { task: { id: 'task_1' } }
    }
    return { dispatchId: 'dispatch_1', state: 'ready' }
  })
}))

vi.mock('./orchestration/desktop-coordinator', () => ({
  createDesktopCoordinator: external.coordinator
}))
vi.mock('./build-review/build-review-rpc-call', () => ({
  createOrchestrationCaller: () => external.call
}))

import {
  failedSessionOutcomeAttempt,
  sessionOutcomeCoordinatorHandle,
  sessionOutcomeCoordinatorPaneKey,
  startLocalSessionOutcomeWorker
} from './session-outcome-local-launch'

const action = {
  id: 'publish',
  instruction: 'Publish the report.',
  conditionIds: ['receipt'],
  authority: 'existing-user-authority' as const,
  agent: 'codex' as const
}

function chain(extra: Partial<SessionChain> = {}): SessionChain {
  return {
    id: 'chain_1',
    workspacePath: '/workspace',
    worktreeId: 'folder:workspace',
    hostId: 'local',
    sourcePaneKey: 'source:pane',
    sourceRowKey: 'source-row',
    auto: true,
    steps: [],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    outcomeSet: {
      outcomes: [{ id: 'outcome', title: 'Publish the report' }]
    } as SessionChain['outcomeSet'],
    ...extra
  }
}

function attempt(extra: Partial<SessionOutcomeAttempt> = {}): SessionOutcomeAttempt {
  return {
    id: 'attempt_1',
    outcomeId: 'outcome',
    actionId: action.id,
    actionKey: 'publish-once',
    outcomeRevision: 1,
    state: 'prepared',
    startedAt: 1,
    updatedAt: 1,
    ...extra
  }
}

function input(
  current: SessionOutcomeAttempt,
  currentChain = chain(),
  liveCoordinator: string | null = null
) {
  const persisted: SessionOutcomeAttempt[] = []
  return {
    persisted,
    runtime: { getLiveTerminalPaneKey: vi.fn(() => liveCoordinator) } as never,
    request: {
      runtime: { getLiveTerminalPaneKey: vi.fn(() => liveCoordinator) } as never,
      chain: currentChain,
      outcomeId: 'outcome',
      action,
      brief: 'Publish the report.',
      attempt: current,
      persist: (next: SessionOutcomeAttempt) => persisted.push(next)
    }
  }
}

beforeEach(() => {
  external.coordinator.mockClear()
  external.call.mockClear()
  external.coordinator.mockImplementation(
    async (_runtime, _worktree, _title, opts) => opts.preAllocatedHandle
  )
  external.call.mockImplementation(async (method: string) => {
    if (method === 'orchestration.runCreate') {
      return { run: { id: 'run_1', hub_task_id: null } }
    }
    if (method === 'orchestration.taskCreate') {
      return { task: { id: 'task_1' } }
    }
    return { dispatchId: 'dispatch_1', state: 'ready' }
  })
})

describe('local outcome coordinator receipt', () => {
  it('reuses a live coordinator for a repeated retry instead of opening another terminal', async () => {
    const first = input(attempt())
    await startLocalSessionOutcomeWorker(first.request)
    const handle = first.persisted[0]?.coordinatorHandle
    expect(handle).toBe(sessionOutcomeCoordinatorHandle(first.request.chain, first.request.attempt))
    expect(first.persisted[0]?.coordinatorPaneKey).toBe(
      sessionOutcomeCoordinatorPaneKey(first.request.chain, first.request.attempt)
    )
    expect(external.coordinator).toHaveBeenCalledOnce()

    const retry = input(attempt({ id: 'attempt_2' }), first.request.chain, 'tab:coordinator')
    await startLocalSessionOutcomeWorker(retry.request)
    expect(retry.persisted[0]?.coordinatorHandle).toBe(handle)
    expect(external.coordinator).toHaveBeenCalledOnce()
  })

  it('adopts the durable pane after a crash with no window, including a remote folder workspace', async () => {
    const remoteFolder = chain({
      worktreeId: 'folder:remote-workspace',
      hostId: 'ssh:studio',
      placement: 'ssh:studio' as never
    })
    const handle = sessionOutcomeCoordinatorHandle(remoteFolder, attempt())
    const paneKey = sessionOutcomeCoordinatorPaneKey(remoteFolder, attempt())
    const crashed = input(
      attempt({ coordinatorHandle: handle, coordinatorPaneKey: paneKey }),
      remoteFolder
    )
    await startLocalSessionOutcomeWorker(crashed.request)

    expect(external.coordinator).toHaveBeenCalledWith(
      crashed.request.runtime,
      'folder:remote-workspace',
      'Outcome continuation',
      expect.objectContaining({
        preAllocatedHandle: handle,
        paneIdentity: expect.objectContaining({ leafId: paneKey.slice(paneKey.indexOf(':') + 1) })
      })
    )
  })

  it('does not replace a legacy coordinator whose live ownership is unavailable', async () => {
    const handle = sessionOutcomeCoordinatorHandle(chain(), attempt())
    const crashed = input(attempt({ coordinatorHandle: handle }), chain())

    await expect(startLocalSessionOutcomeWorker(crashed.request)).resolves.toMatchObject({
      state: 'unverifiable',
      launchDisposition: 'unverifiable'
    })
    expect(external.coordinator).not.toHaveBeenCalled()
    expect(external.call).not.toHaveBeenCalled()
  })

  it('keeps an uncertain Run request unverifiable while a pre-Run coordinator failure stays retryable', () => {
    expect(
      failedSessionOutcomeAttempt(attempt(), new Error('coordinator unavailable'), 10)
    ).toMatchObject({
      state: 'blocked',
      launchDisposition: 'not-started'
    })
    expect(
      failedSessionOutcomeAttempt(
        attempt({ coordinatorHandle: 'term_durable', state: 'launching' }),
        new Error('Run response lost'),
        10
      )
    ).toMatchObject({ state: 'unverifiable', launchDisposition: 'unverifiable' })
  })
})
