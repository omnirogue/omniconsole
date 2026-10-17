import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalWorkflowView } from '../../../shared/local-workflow-view'
import type { LocalWorkflowChangedEvent } from '../../../shared/local-workflow-rpc'
import { closeHostFixtures, hostFixture, waitForState } from './local-workflow-host.test-fixtures'
import { resumeLegacyWorkflowRun } from './local-workflow-legacy-run.test-fixtures'
import { localWorkflowRestingStatus } from './local-workflow-host-live'

// The host is exercised against a deterministic stand-in for the Council package's program.
vi.mock('./presets/council-v6', async () => ({
  runCouncilV6Program: (await import('./local-workflow-host-programs.fixtures')).fakeCouncilProgram
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

afterEach(closeHostFixtures)

function barrier() {
  let release!: () => void
  const launchBarrier = new Promise<void>((resolve) => {
    release = resolve
  })
  return { launchBarrier, release }
}

/** A Council run an earlier build admitted, resumed here so the stand-in program runs live. */
const startCouncil = resumeLegacyWorkflowRun

describe('local workflow host live updates', () => {
  it('pushes the phase, log, live calls and slot waits, then the settled result', async () => {
    const gate = barrier()
    const f = await hostFixture({ launchBarrier: gate.launchBarrier })
    const { executionId, address } = await startCouncil(f)
    const views: LocalWorkflowView[] = []
    const stop = await f.host.watch(address, (view) => views.push(view))
    await vi.waitFor(
      () => {
        const view = views.at(-1)!
        expect(view).toMatchObject({ phase: 'First opinions', log: ['Asking 3 members'] })
        const calls = new Map(view.calls.map((call) => [call.id, call]))
        expect(calls.get('answer/seat-1')).toMatchObject({
          state: 'running',
          seatId: 'seat-1',
          agent: 'claude',
          modelLabel: 'Claude · claude-concrete',
          live: {
            phase: 'running',
            startedAt: 1_000,
            activity: 'Reading src/app.ts',
            tail: 'Thinking about the cache',
            tokens: { input: 10, output: 2 }
          }
        })
        // Two slots: the third member waits for one before any durable row exists.
        expect(calls.get('answer/seat-3')).toMatchObject({
          state: 'queued',
          attempt: 0,
          agent: 'grok',
          live: { phase: 'waiting' }
        })
      },
      { timeout: 5_000 }
    )
    expect(views.every((view) => view.calls.every((call) => call.stdout === ''))).toBe(true)
    gate.release()
    await waitForState(f, executionId, ['completed'])
    await vi.waitFor(
      () => {
        const view = views.at(-1)!
        expect(view.state).toBe('completed')
        expect(view.calls.map((call) => call.id).sort()).toEqual([
          'answer/seat-1',
          'answer/seat-2',
          'answer/seat-3',
          'chair/final'
        ])
        expect(view.calls.every((call) => call.state === 'completed' && !call.live)).toBe(true)
        expect(view.calls.find((call) => call.id === 'chair/final')?.seatId).toBe('seat-1')
        expect(view.phase).toBe('Chairman')
      },
      { timeout: 5_000 }
    )
    stop()
    const count = views.length
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(views.length).toBe(count)
  })

  it('refuses to watch or read calls of another conversation', async () => {
    const f = await hostFixture()
    const { executionId, address } = await startCouncil(f)
    await expect(
      f.host.watch({ ...address, conversationId: 'conversation-b' }, () => {})
    ).rejects.toThrow('another conversation')
    await expect(
      f.host.readCall({ ...address, conversationId: 'conversation-b', callId: 'chair/final' })
    ).rejects.toThrow('another conversation')
    await waitForState(f, executionId, ['completed'])
    // A call that never ran has no captured output; a finished one is read only through its
    // verified receipt, which these stand-in launches never wrote.
    expect(await f.host.readCall({ ...address, callId: 'answer/seat-9' })).toEqual({
      stdout: '',
      stderr: '',
      outputTruncated: false
    })
    await expect(f.host.readCall({ ...address, callId: 'chair/final' })).rejects.toThrow(
      /missing or corrupt/
    )
  })

  it('broadcasts a throttled status for the tab strip and sidebar', async () => {
    const events: LocalWorkflowChangedEvent[] = []
    const f = await hostFixture({ notify: (event) => events.push(event) })
    const { executionId } = await startCouncil(f)
    await waitForState(f, executionId, ['completed'])
    await vi.waitFor(
      () => {
        expect(events.at(-1)).toMatchObject({
          conversationId: 'conversation-a',
          executionId,
          preset: 'council',
          state: 'completed',
          running: 0,
          completed: 4
        })
      },
      { timeout: 5_000 }
    )
    expect(events.every((event) => event.total >= event.completed)).toBe(true)
    // Identical consecutive statuses are not re-sent.
    const keys = events.map((event) => JSON.stringify(event))
    expect(keys.every((key, index) => index === 0 || key !== keys[index - 1])).toBe(true)
  })
})

describe('resting workflow status', () => {
  function view(state: LocalWorkflowView['state']): LocalWorkflowView {
    return {
      executionId: 'execution-1',
      fence: 1,
      sequence: 3,
      preset: 'council',
      state,
      connection: 'connected',
      prompt: 'Q',
      startedAt: 1,
      running: 1,
      queued: 0,
      reused: 0,
      actions: [],
      stages: [],
      calls: [{ id: 'answer/seat-1', state: 'running' } as LocalWorkflowView['calls'][number]],
      phase: 'First opinions'
    }
  }

  it.each([
    ['running', 'paused'],
    ['pausing', 'paused'],
    ['stopping', 'cancelled'],
    ['completed', 'completed'],
    ['failed', 'failed']
  ] as const)('reads an unattended %s run as %s', (state, expected) => {
    const unattended = localWorkflowRestingStatus(view(state), 'tab-1', true)
    expect(unattended).toMatchObject({ conversationId: 'tab-1', state: expected })
    if (expected !== state) {
      expect(unattended.running).toBe(0)
    }
    // A run this host is running, recovering or has settled reports its projected state.
    expect(localWorkflowRestingStatus(view(state), 'tab-1', false)).toMatchObject({
      state,
      running: 1,
      phase: 'First opinions'
    })
  })
})
