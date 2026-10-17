import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeHostFixtures, hostFixture, hostRequest } from './local-workflow-host.test-fixtures'
import { legacyRequest, seedLegacyWorkflowRun } from './local-workflow-legacy-run.test-fixtures'
import { WorkingWorkflowExecutionService } from './working-workflow-execution-service'

// The working service's orchestration caller is never reached by a refused Start.
vi.mock('../build-review/build-review-rpc-call', () => ({
  createOrchestrationCaller: () => async () => {
    throw new Error('Orchestration is not part of this test')
  }
}))

afterEach(() => {
  vi.restoreAllMocks()
  return closeHostFixtures()
})

function rows(f: Awaited<ReturnType<typeof hostFixture>>): unknown {
  return f.db.db.prepare('SELECT COUNT(*) AS count FROM local_workflow_executions').get()
}

describe('Starts the old engines no longer take', () => {
  it('refuses a draft without a graph and writes no row', async () => {
    const f = await hostFixture()
    for (const preset of ['council', 'discover'] as const) {
      expect(await f.host.start(legacyRequest(preset))).toEqual({
        rejected: true,
        reason:
          'This workflow was set up by an earlier version. Open it again from ＋ → Workflow to start it.'
      })
    }
    expect(rows(f)).toMatchObject({ count: 0 })
    expect(f.launches).not.toHaveBeenCalled()
  })

  it('refuses a working-agent draft without starting the working service', async () => {
    const start = vi.spyOn(WorkingWorkflowExecutionService.prototype, 'start')
    const f = await hostFixture({ working: true })
    for (const request of [legacyRequest(), hostRequest()]) {
      request.draft.capability = 'working-agent'
      expect(await f.host.start(request)).toEqual({
        rejected: true,
        reason: 'Working-agent Council and Discover no longer start.'
      })
    }
    expect(start).not.toHaveBeenCalled()
    expect(rows(f)).toMatchObject({ count: 0 })
    expect(f.launches).not.toHaveBeenCalled()
  })

  it('still returns the run of a repeated Start an earlier build admitted', async () => {
    const f = await hostFixture()
    const { executionId, request } = await seedLegacyWorkflowRun(f)
    expect(await f.host.start(request)).toEqual({ executionId })
    // The same request id with another draft is still a conflict, not a refusal of the old engine.
    expect(
      await f.host.start({ ...request, draft: { ...request.draft, prompt: 'Changed' } })
    ).toMatchObject({ rejected: true, reason: expect.stringMatching(/Conflicting/) })
    expect(rows(f)).toMatchObject({ count: 1 })
    expect(f.launches).not.toHaveBeenCalled()
  })
})

describe('placing a Start on the fleet', () => {
  it('refuses a fleet Start with the placement reason and writes no row', async () => {
    const reason =
      "No fleet host has verified spare capacity (mw0002: unreachable, mw0003: stale). Choose 'this computer' to run here."
    const place = vi.fn(async (runsOn: 'fleet' | 'local' | undefined) => {
      if (runsOn === 'local') {
        return { runsOn: 'local' as const, mode: 'local' as const }
      }
      throw new Error(reason)
    })
    const f = await hostFixture({ place })
    const request = hostRequest()
    // A draft from an older client carries no `runsOn`: the host reads that as fleet.
    delete request.draft.runsOn
    expect(await f.host.start(request)).toEqual({ rejected: true, reason })
    expect(place).toHaveBeenLastCalledWith(undefined, undefined)
    expect(
      await f.host.start({ ...request, draft: { ...request.draft, runsOn: 'fleet' } })
    ).toEqual({ rejected: true, reason })
    expect(place).toHaveBeenLastCalledWith('fleet', undefined)
    expect(rows(f)).toMatchObject({ count: 0 })
    expect(f.launches).not.toHaveBeenCalled()
  })

  it('freezes the placement of an admitted run into its snapshot', async () => {
    const placement = {
      runsOn: 'fleet' as const,
      host: { name: 'mw0001', machine: 'macserver-0-01', cores: 24, loadPerCore: 0.2, readAt: 1 },
      mode: 'local' as const
    }
    const f = await hostFixture({ place: vi.fn(async () => placement) })
    const started = await f.host.start(hostRequest())
    expect(started).toHaveProperty('executionId')
    const row = f.db.db
      .prepare('SELECT snapshot_json FROM local_workflow_executions WHERE id=?')
      .get((started as { executionId: string }).executionId) as { snapshot_json: string }
    expect(JSON.parse(row.snapshot_json).snapshot.host.placement).toEqual(placement)
  })
})
