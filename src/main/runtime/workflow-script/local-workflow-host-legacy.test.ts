import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DISCOVER_REVISION } from './discover-program-revision'
import { COUNCIL_REVISION } from './workflow-program-revisions'
import {
  closeHostFixtures,
  hostFixture,
  hostTempDirectory,
  waitForState
} from './local-workflow-host.test-fixtures'
import { legacyRequest, resumeLegacyWorkflowRun } from './local-workflow-legacy-run.test-fixtures'

// Stand-ins for the Council 6 and Discover 7 programs, so only durability and projection are tested.
vi.mock('./presets/council-v6', async () => ({
  runCouncilV6Program: (await import('./local-workflow-host-programs.fixtures')).fakeCouncilProgram
}))
vi.mock('./presets/discover-v7', async () => ({
  runDiscoverV7Program: (await import('./local-workflow-host-programs.fixtures'))
    .fakeDiscoverProgram
}))
vi.mock('./local-workflow-council-projection', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const { fakeFinalMarkdown } = await import('./local-workflow-host-programs.fixtures')
  return {
    ...actual,
    projectCouncilRun: () => undefined,
    councilResultMarkdown: (_snapshot: unknown, results: Map<string, unknown>) =>
      fakeFinalMarkdown(results.get('chair/final'))
  }
})
vi.mock('./local-workflow-discover-projection', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const { fakeFinalMarkdown } = await import('./local-workflow-host-programs.fixtures')
  return {
    ...actual,
    projectDiscoverRun: () => undefined,
    discoverResultMarkdown: (_snapshot: unknown, results: Map<string, unknown>) =>
      fakeFinalMarkdown(results.get('rank/final'))
  }
})

afterEach(closeHostFixtures)

function barrier() {
  let release!: () => void
  const launchBarrier = new Promise<void>((resolve) => {
    release = resolve
  })
  return { launchBarrier, release }
}

function withOutput(fileName: string) {
  const request = legacyRequest()
  request.draft.outputFileName = fileName
  return request
}

describe('a seat-based run an earlier build admitted', () => {
  it('reports a run left mid-flight by a restart as paused, without recovering it', async () => {
    const gate = barrier()
    const f = await hostFixture({ launchBarrier: gate.launchBarrier })
    const { executionId, address } = await resumeLegacyWorkflowRun(f)
    await vi.waitFor(() => expect(f.launches).toHaveBeenCalled())
    const restarted = f.restored()
    expect(await restarted.status(address)).toMatchObject({
      conversationId: 'conversation-a',
      executionId,
      preset: 'council',
      state: 'paused',
      running: 0
    })
    await expect(
      restarted.status({ ...address, conversationId: 'conversation-b' })
    ).rejects.toThrow('another conversation')
    // Reading the status claimed nothing: the original owner still finishes the run.
    gate.release()
    await waitForState(f, executionId, ['completed'])
    expect(await f.host.status(address)).toMatchObject({ state: 'completed', running: 0 })
  })

  it('automatically saves the chairman Markdown once and recognizes it after restart', async () => {
    const f = await hostFixture()
    const { address } = await resumeLegacyWorkflowRun(f, withOutput('PLAN.md'))
    await vi.waitFor(
      async () => {
        expect(await readFile(join(f.path, 'PLAN.md'), 'utf8')).toBe('Supported answer')
      },
      { timeout: 5_000 }
    )
    await vi.waitFor(async () => {
      expect((await f.host.show(address)).savedOutput?.filePath).toBe(
        join(await realpath(f.path), 'PLAN.md')
      )
    })
    const restored = await f.restored().show(address)
    expect(restored.savedOutput?.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(restored.followUpSeat).toMatchObject({
      id: 'seat-1',
      accountId: 'claude-account',
      model: 'claude-concrete',
      policyRevision: 'test-v1'
    })
    expect(restored.followUpLabel).toBe('Claude · claude-concrete')
    expect(restored.usage?.tokens).toEqual({ kind: 'reported', input: 40, output: 8 })
    expect(f.launches).toHaveBeenCalledTimes(4)
  })

  it('tells onSettled once, when this app sees the run finish, and not when a restart reopens it', async () => {
    const settled = vi.fn()
    const f = await hostFixture({ onSettled: settled })
    const { executionId, address } = await resumeLegacyWorkflowRun(f)
    await waitForState(f, executionId, ['completed'])
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1), { timeout: 5_000 })
    expect(settled.mock.calls[0].slice(0, 2)).toEqual([executionId, 'completed'])
    expect((await settled.mock.calls[0][2]()).state).toBe('completed')
    await f.host.show(address)
    // A restarted app reopening the finished run (Discover to OmniOS must not publish it again).
    const restarted = f.restored()
    expect((await restarted.show(address)).state).toBe('completed')
    await restarted.status(address)
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it('never overwrites an output file created after admission', async () => {
    const f = await hostFixture()
    const { address } = await resumeLegacyWorkflowRun(f, withOutput('PLAN.md'))
    await writeFile(join(f.path, 'PLAN.md'), 'another writer')
    await vi.waitFor(async () => {
      expect((await f.host.show(address)).outputError).toMatch(/different content/)
    })
    expect(await readFile(join(f.path, 'PLAN.md'), 'utf8')).toBe('another writer')
  })

  it('refuses to publish when the admitted worktree root becomes a symlink', async () => {
    const path = await hostTempDirectory('omni-council-root-')
    const outside = await hostTempDirectory('omni-council-outside-')
    const moved = `${path}-moved`
    const gate = barrier()
    const f = await hostFixture({ path, launchBarrier: gate.launchBarrier })
    const { address } = await resumeLegacyWorkflowRun(f, withOutput('PLAN.md'))
    await rename(path, moved)
    await symlink(outside, path)
    gate.release()
    await vi.waitFor(async () => {
      expect((await f.host.show(address)).outputError).toMatch(/root changed/)
    })
    await expect(readFile(join(outside, 'PLAN.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(moved, { recursive: true, force: true })
  })

  it('restores the completed anchor in Setup and Show without another paid launch', async () => {
    const f = await hostFixture()
    const { executionId, address } = await resumeLegacyWorkflowRun(f)
    await waitForState(f, executionId, ['completed'])
    expect(f.launches).toHaveBeenCalledTimes(4)
    const restored = f.restored()
    expect((await restored.setup({ ...address, preset: 'council' })).executionId).toBe(executionId)
    const view = await restored.show(address)
    expect(view.state).toBe('completed')
    expect(view.revision).toBe(COUNCIL_REVISION)
    expect(view.result?.markdown).toContain('Supported answer')
    expect(f.launches).toHaveBeenCalledTimes(4)
  })

  it('retries a failed call once inside the run before failing it', async () => {
    const f = await hostFixture({ fail: { callId: 'answer/seat-1', times: 1 } })
    const { executionId } = await resumeLegacyWorkflowRun(f)
    await waitForState(f, executionId, ['completed'])
    expect(f.launches.mock.calls.filter(([id]) => id === 'answer/seat-1')).toHaveLength(2)
    expect(f.launches).toHaveBeenCalledTimes(5)
    expect(
      f.db.db
        .prepare('SELECT budget_reserved,budget_limit FROM local_workflow_executions WHERE id=?')
        .get(executionId)
    ).toMatchObject({ budget_reserved: 5, budget_limit: 21 })
  })

  it('completes around a member that failed both attempts, with its answer left out', async () => {
    const f = await hostFixture({ fail: { callId: 'answer/seat-2', times: 2 } })
    const { executionId, address } = await resumeLegacyWorkflowRun(f)
    await waitForState(f, executionId, ['completed'])
    const view = await f.host.show(address)
    expect(view.state).toBe('completed')
    expect(view.result?.markdown).toContain('Supported answer')
    expect(view.actions).not.toContain('retry')
    expect(view.calls.find((call) => call.id === 'answer/seat-2')).toMatchObject({
      state: 'failed',
      attempt: 2
    })
    expect(f.launches.mock.calls.filter(([id]) => id === 'answer/seat-2')).toHaveLength(2)
  })

  it('lets Retry spend the last persisted attempt of a failed chairman call', async () => {
    const f = await hostFixture({ fail: { callId: 'chair/final', times: 2 } })
    const { executionId, address } = await resumeLegacyWorkflowRun(f)
    await waitForState(f, executionId, ['failed'])
    const failed = await f.host.show(address)
    expect(failed.actions).toContain('retry')
    expect(failed.calls.find((call) => call.id === 'chair/final')).toMatchObject({
      state: 'failed',
      attempt: 2
    })
    await f.host.control({ ...address, fence: failed.fence, action: 'retry' })
    await waitForState(f, executionId, ['completed'])
    const completed = await f.host.show(address)
    expect(completed.actions).not.toContain('retry')
    // The rerun replays the program's log; it is not appended to the failed run's log.
    expect(completed.log).toEqual(['Asking 3 members'])
    expect(f.launches.mock.calls.filter(([id]) => id === 'chair/final')).toHaveLength(3)
    expect(f.launches.mock.calls.filter(([id]) => id === 'answer/seat-2')).toHaveLength(1)
  })

  it('resumes a Discover revision 7 run from its frozen snapshot', async () => {
    const f = await hostFixture()
    const { executionId, address } = await resumeLegacyWorkflowRun(f, legacyRequest('discover'))
    await waitForState(f, executionId, ['completed', 'failed'])
    expect((await f.host.show(address)).revision).toBe(DISCOVER_REVISION)
    const probe = await readFile(
      new URL('../../../../config/scripts/workflows/probe-discover-service.ts', import.meta.url),
      'utf8'
    )
    expect(probe).toContain('discoverProgramRevision: DISCOVER_REVISION')
  })
})
