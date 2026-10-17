import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowPlacement } from '../../../shared/local-workflow-placement'
import { localWorkflowChangedEvent } from '../../../shared/local-workflow-changed'
import { localWorkflowRunStatus } from './local-workflow-run-status'
import { materializeWorkflowContext } from './context/context-folder'
import { createLocalWorkflowGraphDraft } from '../../../shared/local-workflow-draft'
import { workflowTemplate } from '../../../shared/workflow-graph-templates'
import type { LocalWorkflowStartRequest } from '../../../shared/local-workflow-rpc'
import {
  closeHostFixtures,
  hostCatalog,
  hostFixture,
  hostRequest,
  waitForState
} from './local-workflow-host.test-fixtures'

vi.mock('../build-review/build-review-rpc-call', () => ({
  createOrchestrationCaller: () => async () => {
    throw new Error('Orchestration is not part of this test')
  }
}))
vi.mock('./context/context-folder', () => ({ materializeWorkflowContext: vi.fn() }))

afterEach(() => closeHostFixtures())

const HOST = {
  name: 'mw0004',
  machine: 'mw0004',
  cores: 10,
  loadPerCore: 0.1,
  readAt: 5,
  ssh: 'mw0004'
}
const DISPATCHED: WorkflowPlacement = {
  runsOn: 'fleet',
  mode: 'dispatched-seats',
  choice: 'named',
  hostId: 'ssh:ssh-2602',
  host: HOST
}
const READIED: WorkflowPlacement = {
  ...DISPATCHED,
  dispatch: {
    root: '/Users/cloud/.omni-fleet/workflow-runs/r1',
    home: '/Users/cloud',
    hidden: ['/Users/cloud']
  }
}
const WORDS = 'make it so we can launch the workflows on other computers'

function namedRequest() {
  const request = hostRequest()
  request.draft = {
    ...request.draft,
    runsOnHost: 'mw0004',
    runsOnHostId: 'ssh:ssh-2602',
    requestedBy: 'Sal',
    requestedById: 'emp_sal',
    request: WORDS
  }
  return request
}

function snapshotOf(f: Awaited<ReturnType<typeof hostFixture>>, executionId: string) {
  const row = f.db.db
    .prepare('SELECT snapshot_json FROM local_workflow_executions WHERE id=?')
    .get(executionId) as { snapshot_json: string }
  return JSON.parse(row.snapshot_json).snapshot
}

describe('admitting a Start placed on another computer', () => {
  it('refuses an unavailable fleet before preparing the selected repository', async () => {
    const reason = 'No fleet host has verified spare capacity.'
    const f = await hostFixture({
      place: vi.fn(async () => {
        throw new Error(reason)
      })
    })
    const request = namedRequest()
    request.draft = {
      ...request.draft,
      access: 'workspace-read',
      includeWorkspace: false,
      contextSources: [{ kind: 'github', repo: 'acme/app', ref: 'main-next' }]
    }
    expect(await f.host.start(request)).toEqual({ rejected: true, reason })
    expect(materializeWorkflowContext).not.toHaveBeenCalled()
    expect(f.launches).not.toHaveBeenCalled()
  })

  it('refreshes an expired host reading before dispatching the prepared run', async () => {
    const refreshed = { ...DISPATCHED, host: { ...HOST, readAt: Date.now() } }
    const place = vi.fn().mockResolvedValueOnce(DISPATCHED).mockResolvedValueOnce(refreshed)
    const dispatch = vi.fn(async () => READIED)
    const f = await hostFixture({ place, dispatch })
    expect(await f.host.start(namedRequest())).toHaveProperty('executionId')
    expect(place).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenCalledWith(refreshed, expect.anything())
  })

  it('readies the host, skips this computer’s preflight and freezes who asked', async () => {
    const place = vi.fn(async () => DISPATCHED)
    const dispatch = vi.fn(async () => READIED)
    const preflight = vi.fn(async () => {})
    const f = await hostFixture({ place, dispatch, preflight })
    const started = await f.host.start(namedRequest())
    expect(started).toHaveProperty('executionId')
    expect(place).toHaveBeenCalledWith('fleet', { host: 'mw0004', hostId: 'ssh:ssh-2602' })
    expect(dispatch).toHaveBeenCalledWith(
      DISPATCHED,
      expect.objectContaining({ seats: expect.any(Array) })
    )
    expect(preflight).not.toHaveBeenCalled()
    const snapshot = snapshotOf(f, (started as { executionId: string }).executionId)
    expect(snapshot.host).toMatchObject({
      placement: READIED,
      requestedBy: 'Sal',
      requestedById: 'emp_sal',
      request: WORDS
    })
  })

  it('refuses by name when the host cannot be readied, and writes nothing', async () => {
    const reason =
      "Claude is not signed in on mw0004 (claude auth status reports no login over SSH). Choose another host, or 'this computer'."
    const f = await hostFixture({
      place: vi.fn(async () => DISPATCHED),
      dispatch: vi.fn(async () => {
        throw new Error(reason)
      })
    })
    expect(await f.host.start(namedRequest())).toEqual({ rejected: true, reason })
    expect(
      f.db.db.prepare('SELECT COUNT(*) AS count FROM local_workflow_executions').get()
    ).toEqual({ count: 0 })
    expect(f.launches).not.toHaveBeenCalled()
  })

  it('refuses a dispatched placement on a runtime that cannot dispatch', async () => {
    const f = await hostFixture({ place: vi.fn(async () => DISPATCHED) })
    expect(await f.host.start(namedRequest())).toEqual({
      rejected: true,
      reason: 'This runtime cannot dispatch workflow seats to another computer.'
    })
  })

  it('still preflights this computer for a run placed here', async () => {
    const preflight = vi.fn(async () => {})
    const f = await hostFixture({
      place: vi.fn(async () => ({ runsOn: 'local' as const, mode: 'local' as const })),
      preflight
    })
    expect(await f.host.start(hostRequest())).toHaveProperty('executionId')
    expect(preflight).toHaveBeenCalledTimes(1)
  })

  it('shows the placement and requester in the view, the row status and the run status', async () => {
    const f = await hostFixture({
      place: vi.fn(async () => DISPATCHED),
      dispatch: vi.fn(async () => READIED)
    })
    const request = namedRequest()
    const { executionId } = (await f.host.start(request)) as { executionId: string }
    // The fixture's answers need not satisfy Council; only where the run went is asserted here.
    await waitForState(f, executionId, ['completed', 'failed'])
    const view = await f.host.show({
      worktree: request.worktree,
      conversationId: request.conversationId,
      executionId
    })
    expect(view).toMatchObject({
      placement: { ...READIED, dispatch: { ...READIED.dispatch, hidden: [] } },
      requestedBy: 'Sal',
      request: WORDS
    })
    expect(localWorkflowChangedEvent(view, request.conversationId)).toMatchObject({
      host: 'mw0004',
      sshHost: READIED.host?.ssh,
      requestedBy: 'Sal'
    })
    const status = localWorkflowRunStatus(f.db.db, f.host.project(executionId))
    expect(status).toMatchObject({
      executionId,
      worktreeId: request.worktree,
      conversationId: request.conversationId,
      state: view.state,
      requestedBy: 'Sal',
      request: WORDS,
      placement: { host: { name: 'mw0004' }, mode: 'dispatched-seats' }
    })
    expect(status.seats.length).toBeGreaterThan(0)
    // The fixture launches here, so its receipts name no fleet host.
    expect(status.seats[0]).toMatchObject({ attempt: 1, host: 'this computer' })
  })
})

/** A default Discover: left on the fleet, nobody named a host. */
function discoverRequest(named = false): LocalWorkflowStartRequest {
  const draft = createLocalWorkflowGraphDraft({
    prompt: 'Find what slows checkout',
    concurrency: 2,
    graph: {
      spec: workflowTemplate('discover', ['claude', 'codex', 'grok']),
      team: hostCatalog.map(({ agent, accountId }, index) => ({
        id: `seat-${index + 1}`,
        agent,
        accountId
      }))
    }
  })
  return {
    worktree: 'workspace-a',
    conversationId: 'conversation-discover',
    requestId: 'request-discover',
    preset: 'discover',
    draft: named ? { ...draft, runsOnHost: 'mw0004', runsOnHostId: 'ssh:ssh-2602' } : draft
  }
}

const AUTO: WorkflowPlacement = { runsOn: 'fleet', mode: 'dispatched-seats', host: HOST }
const GROK =
  "Seats on mw0004 run Claude and Codex on its own subscription logins; Grok cannot run there. Choose Claude and Codex seats, or 'this computer'."

describe('a Discover the fleet cannot take (Sal, 2026-10-14: "Run it on this Mac instead")', () => {
  it('tries a second verified host after dispatch readiness fails', async () => {
    const other = { ...AUTO, host: { ...HOST, name: 'mw0001', machine: 'mw0001' } }
    const place = vi.fn(
      async (_runsOn: unknown, _pick: unknown, excluded: readonly string[] = []) =>
        excluded.includes('mw0004') ? other : AUTO
    )
    const dispatch = vi.fn(async (placement: WorkflowPlacement) => {
      if (placement.host?.machine === 'mw0004') {
        throw new Error('mw0004 signed out')
      }
      return { ...placement, dispatch: READIED.dispatch }
    })
    const f = await hostFixture({ place, dispatch })
    const started = (await f.host.start(discoverRequest())) as { executionId: string }
    expect(snapshotOf(f, started.executionId).host.placement).toMatchObject({
      host: { name: 'mw0001' }
    })
    expect(dispatch).toHaveBeenCalledTimes(2)
    await waitForState(f, started.executionId, ['completed', 'failed'])
  })

  it('runs here, preflighted here, with the fleet refusal kept as the reason', async () => {
    const preflight = vi.fn(async () => {})
    const f = await hostFixture({
      place: vi.fn(async () => AUTO),
      dispatch: vi.fn(async () => {
        throw new Error(GROK)
      }),
      preflight
    })
    const started = await f.host.start(discoverRequest())
    expect(started).toHaveProperty('executionId')
    const executionId = (started as { executionId: string }).executionId
    expect(preflight).toHaveBeenCalledTimes(1)
    expect(snapshotOf(f, executionId).host.placement).toEqual({
      runsOn: 'fleet',
      mode: 'local',
      fallback: GROK
    })
    await waitForState(f, executionId, ['completed', 'failed'])
  })

  it('runs here when no fleet host has spare capacity, or this runtime cannot dispatch', async () => {
    const reason = 'No fleet host has verified spare capacity: mw0001 unreachable.'
    const f = await hostFixture({
      place: vi.fn(async () => {
        throw new Error(reason)
      }),
      preflight: vi.fn(async () => {})
    })
    const started = (await f.host.start(discoverRequest())) as { executionId: string }
    expect(snapshotOf(f, started.executionId).host.placement).toMatchObject({ fallback: reason })
    await waitForState(f, started.executionId, ['completed', 'failed'])
    const g = await hostFixture({
      place: vi.fn(async () => AUTO),
      preflight: vi.fn(async () => {})
    })
    const again = (await g.host.start(discoverRequest())) as { executionId: string }
    expect(snapshotOf(g, again.executionId).host.placement).toMatchObject({
      mode: 'local',
      fallback: 'This runtime cannot dispatch workflow seats to another computer.'
    })
    await waitForState(g, again.executionId, ['completed', 'failed'])
  })

  it('still refuses a host the person named, and any other template', async () => {
    const dispatch = vi.fn(async () => {
      throw new Error(GROK)
    })
    const named = await hostFixture({ place: vi.fn(async () => DISPATCHED), dispatch })
    expect(await named.host.start(discoverRequest(true))).toEqual({ rejected: true, reason: GROK })
    const council = await hostFixture({ place: vi.fn(async () => AUTO), dispatch })
    expect(await council.host.start(hostRequest())).toEqual({ rejected: true, reason: GROK })
  })
})
