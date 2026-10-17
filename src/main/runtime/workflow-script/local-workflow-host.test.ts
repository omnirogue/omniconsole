import { afterEach, describe, expect, it } from 'vitest'
import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import {
  catalogEntry,
  closeHostFixtures,
  hostCatalog,
  hostFixture,
  hostRequest as request,
  hostTempDirectory,
  waitForState
} from './local-workflow-host.test-fixtures'
import { GRAPH_PROGRAM_REVISION } from './workflow-program-revisions'

// These stand-in launches do not answer a graph's prompts, so a run may fail; only admission counts.
const SETTLED = ['completed', 'failed']

afterEach(closeHostFixtures)

function executionRow(f: Awaited<ReturnType<typeof hostFixture>>, id: string) {
  const row = f.db.db
    .prepare(
      'SELECT snapshot_json,call_limit,attempt_limit,budget_limit,budget_reserved FROM local_workflow_executions WHERE id=?'
    )
    .get(id) as {
    snapshot_json: string
    call_limit: number
    attempt_limit: number
    budget_limit: number
    budget_reserved: number
  }
  return { ...row, snapshot: JSON.parse(row.snapshot_json).snapshot }
}

async function started(f: Awaited<ReturnType<typeof hostFixture>>, start = request()) {
  const result = await f.host.start(start)
  if (!('executionId' in result)) {
    throw new Error(`Expected admitted workflow: ${result.reason}`)
  }
  return {
    executionId: result.executionId,
    address: {
      worktree: start.worktree,
      conversationId: start.conversationId,
      executionId: result.executionId
    }
  }
}

describe('local workflow host setup', () => {
  it('offers every eligible route once, all as members, with Claude in the chair', async () => {
    const f = await hostFixture({
      seatCatalog: [...hostCatalog, catalogEntry('gemini', 'google')].toReversed()
    })
    const council = await f.host.setup({
      worktree: 'workspace-a',
      conversationId: 'conversation-a',
      preset: 'council'
    })
    expect(council.defaults?.seats.map((seat) => [seat.id, seat.agent])).toEqual([
      ['seat-1', 'claude'],
      ['seat-2', 'codex'],
      ['seat-3', 'grok'],
      ['seat-4', 'gemini']
    ])
    expect(council.defaults?.council?.memberIds).toEqual(['seat-1', 'seat-2', 'seat-3', 'seat-4'])
    expect(council.defaults?.synthesizerId).toBe('seat-1')
    expect(council.unavailableReason).toBeUndefined()
    const discover = await f.host.setup({
      worktree: 'workspace-a',
      conversationId: 'conversation-b',
      preset: 'discover'
    })
    expect(discover.defaults?.discover.finderIds).toEqual(['seat-1', 'seat-2', 'seat-3'])
  })

  it('leaves a Grok that cannot stream out of the default lineup', async () => {
    const f = await hostFixture({
      seatCatalog: hostCatalog.map((entry) =>
        entry.agent === 'grok' ? { ...entry, streamUnavailableReason: 'Sign in to Grok.' } : entry
      )
    })
    const setup = await f.host.setup({
      worktree: 'workspace-a',
      conversationId: 'conversation-a',
      preset: 'council'
    })
    expect(setup.defaults?.seats.map((seat) => seat.agent)).toEqual(['claude', 'codex'])
    // The catalog itself still offers Grok to working agents and follow-ups.
    expect(setup.catalog.find((entry) => entry.agent === 'grok')?.unavailableReason).toBeUndefined()
  })

  it('chairs with the first non-Google seat when Claude is absent', async () => {
    const f = await hostFixture({
      seatCatalog: [catalogEntry('gemini', 'google'), catalogEntry('grok', 'xai')]
    })
    const setup = await f.host.setup({
      worktree: 'workspace-a',
      conversationId: 'conversation-a',
      preset: 'council'
    })
    expect(setup.defaults?.seats.map((seat) => seat.agent)).toEqual(['grok', 'gemini'])
    expect(setup.defaults?.synthesizerId).toBe('seat-1')
    expect(setup.unavailableReason).toBeUndefined()
  })

  it.each([
    ['no routes', []],
    ['one route', [catalogEntry('claude', 'anthropic')]],
    ['only Google', [catalogEntry('gemini', 'google')]]
  ] as const)('explains that %s cannot run a workflow', async (_label, seatCatalog) => {
    const f = await hostFixture({ seatCatalog: [...seatCatalog] })
    const setup = await f.host.setup({
      worktree: 'workspace-a',
      conversationId: 'conversation-a',
      preset: 'council'
    })
    expect(setup.unavailableReason).toBe(
      'Set up at least two of Claude, Codex, Grok or Gemini to run a workflow.'
    )
  })
})

describe('local workflow host admission', () => {
  it('pins the graph revision with read-only workspace access and derived limits', async () => {
    const f = await hostFixture()
    const { executionId } = await started(f)
    const row = executionRow(f, executionId)
    const root = await realpath(f.path)
    const info = await lstat(root, { bigint: true })
    expect(row.snapshot).toMatchObject({
      graphProgramRevision: GRAPH_PROGRAM_REVISION,
      capability: { mode: 'frozen-analysis', revision: 1 },
      access: 'workspace-read',
      host: {
        workspaceRoot: { path: root, device: String(info.dev), inode: String(info.ino) }
      }
    })
    expect(row.attempt_limit).toBe(3)
    expect(row.budget_limit).toBe(row.call_limit * 3)
    await waitForState(f, executionId, SETTLED)
  })

  it('freezes attached text only when the draft opts out of workspace access', async () => {
    const f = await hostFixture()
    const start = request()
    start.draft.access = 'frozen'
    const { executionId } = await started(f, start)
    const row = executionRow(f, executionId)
    expect(row.snapshot.access).toBeUndefined()
    expect(row.snapshot.host.workspaceRoot).toBeUndefined()
    await waitForState(f, executionId, SETTLED)
  })

  it('refuses a workspace folder that no longer exists and prompts over 32,000 characters', async () => {
    const f = await hostFixture({ path: join(await hostTempDirectory('omni-gone-'), 'missing') })
    expect(await f.host.start(request())).toMatchObject({ rejected: true })
    const long = request()
    long.draft.prompt = 'x'.repeat(32_001)
    long.requestId = 'request-2'
    expect(await f.host.start(long)).toMatchObject({
      rejected: true,
      reason: expect.stringMatching(/32,000/)
    })
    expect(f.launches).not.toHaveBeenCalled()
  })

  it('returns a refusal when the store rejects a second unfinished run', async () => {
    const gate = { release: () => {} }
    const launchBarrier = new Promise<void>((resolve) => {
      gate.release = resolve
    })
    const f = await hostFixture({ launchBarrier })
    const { executionId } = await started(f)
    const second = request()
    second.requestId = 'request-2'
    expect(await f.host.start(second)).toMatchObject({
      rejected: true,
      reason: expect.stringMatching(/unfinished workflow/)
    })
    gate.release()
    await waitForState(f, executionId, SETTLED)
  })

  it('reports unavailable routes without inventing seats or admitting a partial team', async () => {
    const f = await hostFixture({ seatCatalog: [] })
    const setup = await f.host.setup({
      worktree: 'workspace-a',
      conversationId: 'conversation-a',
      preset: 'council'
    })
    expect(setup.defaults?.seats).toEqual([])
    expect(await f.host.start(request())).toMatchObject({ rejected: true })
    expect(
      f.db.db.prepare('SELECT COUNT(*) AS count FROM local_workflow_executions').get()
    ).toMatchObject({ count: 0 })
    expect(f.launches).not.toHaveBeenCalled()
  })

  it('deduplicates Start and rejects a changed draft under the same request id', async () => {
    const f = await hostFixture()
    const first = request()
    const accepted = await f.host.start(first)
    expect(accepted).toHaveProperty('executionId')
    expect(await f.host.start(first)).toEqual(accepted)
    expect(
      await f.host.start({ ...first, draft: { ...first.draft, prompt: 'Changed' } })
    ).toMatchObject({ rejected: true, reason: expect.stringMatching(/Conflicting/) })
    expect(
      f.db.db.prepare('SELECT COUNT(*) AS count FROM local_workflow_executions').get()
    ).toMatchObject({ count: 1 })
    if ('executionId' in accepted) {
      await waitForState(f, accepted.executionId, SETTLED)
    }
  })

  it('rejects invalid input before admission and does not reuse its request id', async () => {
    const f = await hostFixture()
    const original = request()
    expect(
      await f.host.start({ ...original, draft: { ...original.draft, prompt: ' ' } })
    ).toMatchObject({ rejected: true })
    expect(
      f.db.db.prepare('SELECT COUNT(*) AS count FROM local_workflow_executions').get()
    ).toMatchObject({ count: 0 })
    const { executionId } = await started(f, original)
    await waitForState(f, executionId, SETTLED)
  })

  it('binds Show to both workspace and conversation', async () => {
    const f = await hostFixture()
    const { executionId } = await started(f)
    await expect(
      f.host.show({ worktree: 'workspace-b', conversationId: 'conversation-a', executionId })
    ).rejects.toThrow('another conversation')
    await expect(
      f.host.show({ worktree: 'workspace-a', conversationId: 'conversation-b', executionId })
    ).rejects.toThrow('another conversation')
    await waitForState(f, executionId, SETTLED)
  })
})
