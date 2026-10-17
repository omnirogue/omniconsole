import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The launch's external steps, in the order it takes them. Each is a door the host cannot take
// back (a terminal, a Run, a Task, an agent), so the test counts them rather than running them.
const external = vi.hoisted(() => {
  const steps: string[] = []
  return {
    steps,
    coordinator: vi.fn(async (_runtime, _worktree, _title, opts) => opts.preAllocatedHandle),
    call: vi.fn(async (method: string) => {
      steps.push(method)
      if (method === 'orchestration.runCreate') {
        return { run: { id: 'run_1', hub_task_id: null } }
      }
      if (method === 'orchestration.taskCreate') {
        return { task: { id: 'task_1' } }
      }
      return { dispatchId: 'ctx_1', state: 'ready' }
    })
  }
})
vi.mock('./orchestration/desktop-coordinator', () => ({
  createDesktopCoordinator: external.coordinator
}))
vi.mock('./build-review/build-review-rpc-call', () => ({
  createOrchestrationCaller: () => external.call
}))

import { normalizeSessionChain } from '../../shared/session-chain-types'
import { reviseSessionOutcomeSet } from '../../shared/session-outcome-state'
import type { SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { launchSessionOutcomeAction } from './session-outcome-executor'
import {
  SESSION_OUTCOME_ATTEMPT_STALE,
  SessionOutcomeLaunches
} from './session-outcome-launch-detach'

const action = {
  id: 'publish',
  instruction: 'Publish the export.',
  conditionIds: ['receipt'],
  authority: 'existing-user-authority' as const,
  agent: 'codex' as const
}

function committedChain() {
  const set = reviseSessionOutcomeSet(
    undefined,
    {
      expectedRevision: 0,
      source: 'user',
      outcomes: [
        {
          id: 'release',
          title: 'Release the export',
          finish: 'complete',
          dependsOn: [],
          actions: [action],
          conditions: [{ id: 'receipt', kind: 'file', target: '/work/export.csv' }]
        }
      ]
    },
    { owner: 'execution-host', hostId: 'local', epoch: 'owner', state: 'owned' },
    1
  )
  return normalizeSessionChain({
    id: 'chain',
    workspacePath: '/work',
    worktreeId: 'folder:work',
    sourcePaneKey: 'pane',
    sourceRowKey: 'row',
    steps: [],
    outcomeSet: set
  })!
}

/**
 * Launch one action the way the tick does: the attempt is made durable at `prepared` inside the
 * tick, and the readiness wait runs detached, persisting each checkpoint through the chain's lane.
 * `accepts` scripts that lane: how many detached checkpoints it records before the run moves on
 * (sealed, superseded, revised) and every later event is dropped as stale.
 */
async function launchDetached(accepts: number) {
  const launches = new SessionOutcomeLaunches()
  const recorded: SessionOutcomeAttempt[] = []
  const offered: SessionOutcomeAttempt[] = []
  const runtime = { getLiveTerminalPaneKey: vi.fn(() => null) } as never as OrcaRuntimeService
  const detach = launches.detachWith(async (attempt) => {
    offered.push(attempt)
    if (recorded.length >= accepts) {
      throw new Error(SESSION_OUTCOME_ATTEMPT_STALE)
    }
    recorded.push(attempt)
  })
  const prepared = await launchSessionOutcomeAction(
    runtime,
    committedChain(),
    'release',
    action,
    () => {},
    detach
  )
  await launches.settled()
  expect(launches.inFlight(prepared.id)).toBe(false)
  return { prepared, recorded, offered }
}

let warned: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  external.steps.length = 0
  external.coordinator.mockClear()
  external.call.mockClear()
  // The refusal is reported by the launch host as a warning; it is what these rows provoke.
  warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warned.mockRestore()
})

describe('a detached launch whose checkpoint the run refuses', () => {
  it('takes every external step, in order, while its checkpoints are recorded', async () => {
    const { prepared, recorded } = await launchDetached(Number.POSITIVE_INFINITY)
    expect(prepared.state).toBe('prepared')
    expect(external.steps).toEqual([
      'orchestration.runCreate',
      'orchestration.taskCreate',
      'orchestration.workerStart'
    ])
    expect(recorded.at(-1)).toMatchObject({
      id: prepared.id,
      state: 'running',
      dispatchId: 'ctx_1',
      launchDisposition: 'started'
    })
    expect(recorded[0]).toMatchObject({
      id: prepared.id,
      coordinatorHandle: expect.stringMatching(/^term_/),
      coordinatorPaneKey: expect.stringMatching(/^outcome-[^:]+:[0-9a-f-]{36}$/)
    })
  })

  it.each([
    { accepts: 0, coordinators: 0, taken: [] },
    { accepts: 1, coordinators: 1, taken: [] },
    { accepts: 2, coordinators: 1, taken: ['orchestration.runCreate'] },
    {
      accepts: 3,
      coordinators: 1,
      taken: ['orchestration.runCreate', 'orchestration.taskCreate']
    }
  ])(
    'stops after $accepts recorded checkpoint(s): no later external step, and no agent',
    async ({ accepts, coordinators, taken }) => {
      const { recorded, offered } = await launchDetached(accepts)
      // The step BEFORE the refused checkpoint already happened; nothing after it does.
      expect(external.steps).toEqual(taken)
      expect(external.coordinator).toHaveBeenCalledTimes(coordinators)
      expect(external.steps).not.toContain('orchestration.workerStart')
      expect(recorded).toHaveLength(accepts)
      // It reports the refusal once (its own failure record) and is refused again: the run moved
      // on, so nothing about this attempt is written, and it does not try anything else.
      expect(offered).toHaveLength(accepts + 2)
      expect(warned).toHaveBeenCalledWith(
        '[outcomes] detached launch failed',
        expect.any(String),
        expect.objectContaining({ message: SESSION_OUTCOME_ATTEMPT_STALE })
      )
    }
  )

  it('starts the agent at most once even when the final checkpoint is refused', async () => {
    await launchDetached(4)
    expect(external.steps.filter((step) => step === 'orchestration.workerStart')).toHaveLength(1)
  })
})
