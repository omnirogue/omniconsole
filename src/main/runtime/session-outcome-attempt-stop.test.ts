import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from './omni-runtime'
import { stopSessionAttemptWorker } from './session-outcome-attempt-stop'

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), lifecycle: vi.fn() }))
vi.mock('./rpc/methods/orchestration-worker-observation', () => ({
  inspectWorkerTerminal: mocks.inspect
}))
vi.mock('./build-review/build-review-rpc-call', () => ({
  createOrchestrationCaller: () => mocks.lifecycle
}))

function fixture() {
  const resource = {
    owner_dispatch_id: 'dispatch',
    terminal_handle: 'term_old',
    ownership_state: 'owned',
    release_state: 'not_requested',
    retained_reason: null as string | null,
    process_incarnation: 'runtime:old:1',
    host_scope: JSON.stringify({ kind: 'local', hostId: 'local' })
  }
  const worker = {
    agent_terminal_handle: 'term_old',
    state: 'failed',
    start_options: JSON.stringify({
      completionPolicy: {
        kind: 'release_on_accepted_completion',
        coordinator: { worktreeId: 'workspace', paneKey: 'parent:leaf' }
      }
    })
  }
  const db = {
    getFederatedDispatch: vi.fn().mockReturnValue(null),
    getWorkerDispatch: () => worker,
    getDispatchContextById: () => ({ process_incarnation: 'runtime:old:1' }),
    getWorkerTerminalResourceByOwner: vi.fn().mockReturnValue(resource),
    getWorkerTerminalResourceFormerlyOwnedBy: vi.fn().mockReturnValue(null),
    getWorkerTerminalArchive: vi.fn().mockReturnValue(null)
  }
  const liveness = vi.fn().mockResolvedValue('unverifiable')
  const closeTerminal = vi.fn()
  const runtime = {
    getOrchestrationDb: () => db,
    inspectTerminalProcessIncarnationLiveness: liveness,
    closeTerminal
  } as unknown as OrcaRuntimeService
  return { runtime, db, resource, worker, liveness, closeTerminal }
}

describe('outcome retry waits for the original execution owner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.inspect.mockResolvedValue({ status: 'live', exact: true })
    mocks.lifecycle.mockResolvedValue({ state: 'released' })
  })

  it.each(['missing', 'unattached', 'identity_changed', 'exited'])(
    'requires exact owner exit even when inventory reports %s',
    async (status) => {
      const f = fixture()
      mocks.inspect.mockResolvedValue({ status, exact: status === 'exited' })
      for (const verdict of ['live', 'unverifiable']) {
        f.liveness.mockResolvedValue(verdict)
        expect(await stopSessionAttemptWorker(f.runtime, { dispatchId: 'dispatch' })).toBe(
          'unknown'
        )
      }
      f.liveness.mockResolvedValue('exited')
      expect(await stopSessionAttemptWorker(f.runtime, { dispatchId: 'dispatch' })).toBe('stopped')
      expect(f.liveness).toHaveBeenLastCalledWith('runtime:old:1', f.resource.host_scope)
      expect(mocks.lifecycle).not.toHaveBeenCalled()
      expect(f.closeTerminal).not.toHaveBeenCalled()
    }
  )

  it.each(['missing resource', 'changed incarnation', 'missing host'])(
    'does not guess the execution owner from %s',
    async (change) => {
      const f = fixture()
      mocks.inspect.mockResolvedValue({ status: 'identity_changed', exact: false })
      if (change === 'missing resource') {
        f.db.getWorkerTerminalResourceByOwner.mockReturnValue(null)
      } else if (change === 'changed incarnation') {
        f.resource.process_incarnation = 'runtime:new:2'
      } else {
        f.resource.host_scope = ''
      }
      expect(await stopSessionAttemptWorker(f.runtime, { dispatchId: 'dispatch' })).toBe('unknown')
      expect(f.liveness).not.toHaveBeenCalled()
      expect(mocks.lifecycle).not.toHaveBeenCalled()
    }
  )

  it('can prove the old incarnation exited after ownership transferred without touching its replacement', async () => {
    const f = fixture()
    mocks.inspect.mockResolvedValue({ status: 'identity_changed', exact: false })
    f.db.getWorkerTerminalResourceByOwner.mockReturnValue(null)
    f.db.getWorkerTerminalResourceFormerlyOwnedBy.mockReturnValue(f.resource)
    f.liveness.mockResolvedValue('exited')
    expect(await stopSessionAttemptWorker(f.runtime, { dispatchId: 'dispatch' })).toBe('stopped')
    expect(mocks.lifecycle).not.toHaveBeenCalled()
    expect(f.closeTerminal).not.toHaveBeenCalled()
  })

  it.each([
    ['released', undefined, 'stopped'],
    ['already_released', undefined, 'stopped'],
    ['release_pending', undefined, 'pending'],
    ['retained', 'pending_obligations', 'pending'],
    ['retained', 'protection_held', 'pending'],
    ['retained', 'identity_unproven', 'unknown'],
    ['release_unknown', undefined, 'unknown']
  ] as const)(
    'maps the archived descendant-aware release receipt %s (%s) for a settled failed worker to %s',
    async (state, reason, outcome) => {
      const f = fixture()
      mocks.lifecycle.mockResolvedValue({ state, reason })
      expect(await stopSessionAttemptWorker(f.runtime, { dispatchId: 'dispatch' })).toBe(outcome)
      expect(mocks.lifecycle).toHaveBeenCalledWith('orchestration.workerRelease', {
        dispatch: 'dispatch'
      })
      expect(f.closeTerminal).not.toHaveBeenCalled()
    }
  )

  it('does not equate root exit with completion of a captured descendant cleanup', async () => {
    const f = fixture()
    mocks.inspect.mockResolvedValue({ status: 'missing', exact: false })
    f.liveness.mockResolvedValue('exited')
    f.resource.release_state = 'releasing'
    f.db.getWorkerTerminalArchive.mockReturnValue({ content: 'captured tree' })
    mocks.lifecycle.mockResolvedValue({ state: 'release_pending' })
    expect(await stopSessionAttemptWorker(f.runtime, { dispatchId: 'dispatch' })).toBe('pending')
    mocks.lifecycle.mockResolvedValue({ state: 'released' })
    expect(await stopSessionAttemptWorker(f.runtime, { dispatchId: 'dispatch' })).toBe('stopped')
    expect(f.closeTerminal).not.toHaveBeenCalled()
  })

  it.each(['durable', 'user_owned', 'external', 'user_requested'])(
    'preserves a live %s worker instead of overriding its lifecycle for a retry',
    async (reason) => {
      const f = fixture()
      if (reason === 'durable') {
        f.worker.start_options = '{}'
      } else if (reason === 'user_owned' || reason === 'external') {
        f.resource.ownership_state = reason
      } else {
        f.resource.release_state = 'retained'
        f.resource.retained_reason = reason
      }
      // Why: a protection can lift (a routine finishes, a person releases the pane); durable
      // ownership, a kept worker and a missing policy are not the retry ladder's to override.
      expect(await stopSessionAttemptWorker(f.runtime, { dispatchId: 'dispatch' })).toBe('unknown')
      expect(mocks.lifecycle).not.toHaveBeenCalled()
      expect(f.closeTerminal).not.toHaveBeenCalled()
    }
  )

  it.each(['live', 'missing'])(
    'revalidates temporary protection after it lifts with %s inventory',
    async (status) => {
      const f = fixture()
      mocks.inspect.mockResolvedValue({ status })
      if (status === 'missing') {
        f.liveness.mockResolvedValue('exited')
        f.db.getWorkerTerminalArchive.mockReturnValue({ content: 'captured tree' })
      }
      f.resource.release_state = 'retained'
      f.resource.retained_reason = 'protection_held'
      mocks.lifecycle.mockResolvedValueOnce({ state: 'retained', reason: 'protection_held' })
      expect(await stopSessionAttemptWorker(f.runtime, { dispatchId: 'dispatch' })).toBe('pending')
      mocks.lifecycle.mockResolvedValueOnce({ state: 'released' })
      expect(await stopSessionAttemptWorker(f.runtime, { dispatchId: 'dispatch' })).toBe('stopped')
      expect(mocks.lifecycle).toHaveBeenCalledTimes(2)
      expect(mocks.lifecycle).toHaveBeenLastCalledWith('orchestration.workerRelease', {
        dispatch: 'dispatch'
      })
      expect(f.closeTerminal).not.toHaveBeenCalled()
    }
  )

  it('treats a lifecycle call that fails to answer as pending, never as a verdict', async () => {
    const f = fixture()
    mocks.lifecycle.mockRejectedValue(new Error('endpoint unavailable'))
    expect(await stopSessionAttemptWorker(f.runtime, { dispatchId: 'dispatch' })).toBe('pending')
    expect(f.closeTerminal).not.toHaveBeenCalled()
  })

  it('uses the existing stop authority for an active finite worker', async () => {
    const f = fixture()
    f.worker.state = 'ready'
    mocks.lifecycle.mockResolvedValue({ state: 'stopped' })
    expect(await stopSessionAttemptWorker(f.runtime, { dispatchId: 'dispatch' })).toBe('stopped')
    expect(mocks.lifecycle).toHaveBeenCalledWith('orchestration.workerStop', {
      dispatch: 'dispatch'
    })
  })

  it('keeps federated cancellation on the pinned owner stop path', async () => {
    const f = fixture()
    f.db.getFederatedDispatch.mockReturnValue({ dispatch_id: 'dispatch' })
    mocks.lifecycle.mockResolvedValue({ state: 'stop_unknown' })
    expect(await stopSessionAttemptWorker(f.runtime, { dispatchId: 'dispatch' })).toBe('unknown')
    mocks.lifecycle.mockResolvedValue({ state: 'stop_requested' })
    expect(await stopSessionAttemptWorker(f.runtime, { dispatchId: 'dispatch' })).toBe('pending')
    mocks.lifecycle.mockResolvedValue({ state: 'stopped' })
    expect(await stopSessionAttemptWorker(f.runtime, { dispatchId: 'dispatch' })).toBe('stopped')
    expect(mocks.inspect).not.toHaveBeenCalled()
    expect(f.liveness).not.toHaveBeenCalled()
  })
})
