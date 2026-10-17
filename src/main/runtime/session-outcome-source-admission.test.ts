import { afterEach, expect, it, vi } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { sessionOutcomeSource } from './session-outcome-source-authority'
import type { SessionChain, SessionChainState } from '../../shared/session-chain-types'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.dispose()
  }
})

function fixture() {
  const f = outcomeRuntimeFixture(() => {
    throw new Error('No legacy step may relaunch')
  })
  fixtures.push(f)
  const task = f.db.createTask({ spec: 'Write the approved report.' })
  const dispatch = f.db.createStartingWorkerDispatch({
    taskId: task.id,
    creator: { kind: 'system' },
    maxDepth: 1,
    startOptions: {}
  }).dispatch
  const capability = f.db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle: 'source',
    paneKey: f.runtime.getTerminalPaneKey('source')!,
    processIncarnation: f.runtime.getTerminalProcessIncarnation('source')!,
    worktreeId: 'folder:outcome',
    effects: [],
    setupState: 'skipped'
  })
  vi.mocked(f.runtime.getFreshAgentHookStatusForHandle).mockReturnValue({
    state: 'working',
    lastAssistantMessage: null,
    interactivePrompt: null,
    stateStartedAt: 1,
    updatedAt: Date.now()
  })
  vi.mocked(f.runtime.resolveTerminalPane).mockReturnValue({
    handle: 'source',
    ptyId: 'source-pty',
    tabId: 'tab',
    leafId: 'leaf',
    connected: true,
    worktreeId: 'folder:outcome'
  })
  const context = { runtime: f.runtime, orchestrationCapability: capability }
  return {
    ...f,
    read: () =>
      sessionOutcomeSource(context, {
        paneKey: f.runtime.getTerminalPaneKey('source')!,
        worktreeId: 'folder:outcome'
      })
  }
}

function legacy(base: SessionChain, state: SessionChainState): SessionChain {
  return {
    ...base,
    id: 'legacy',
    state,
    steps: [
      {
        id: 'already-launched',
        agent: 'codex',
        prompt: 'Already commissioned work.',
        status: 'launched',
        launchedPaneKey: 'existing-worker'
      }
    ],
    currentIndex: 1
  }
}

it.each(['waiting', 'ready', 'launching', 'failed'] as const)(
  'refuses %s legacy source work without adopting or relaunching steps',
  async (state) => {
    const f = fixture()
    const source = await f.read()
    const old = legacy(source.chain, state)
    vi.mocked(f.runtime.listSessionChains).mockReturnValue([old])
    await expect(f.read()).rejects.toThrow('unfinished legacy Next plan')
    expect(old.steps[0]!.status).toBe('launched')
    expect(f.runtime.replaceSessionChainOutcomesAndFlush).not.toHaveBeenCalled()
    expect(f.launched).toEqual([])
  }
)

it.each(['done', 'cancelled'] as const)(
  'does not reinterpret a %s legacy plan as fresh host work',
  async (state) => {
    const f = fixture()
    const source = await f.read()
    vi.mocked(f.runtime.listSessionChains).mockReturnValue([legacy(source.chain, state)])
    await expect(f.read()).rejects.toThrow('completed or cancelled legacy Next plan')
    expect(f.runtime.replaceSessionChainOutcomesAndFlush).not.toHaveBeenCalled()
  }
)

async function bind(f: ReturnType<typeof fixture>, chain: SessionChain) {
  return f.service.commit(chain, {
    source: 'user',
    expectedRevision: 0,
    outcomes: [
      {
        id: 'report',
        title: 'Report',
        finish: 'complete',
        dependsOn: [],
        actions: [],
        conditions: [{ id: 'file', kind: 'file', target: `${f.workspace}/report.txt` }]
      }
    ]
  })
}

it('adopts only the already-bound set beside terminal legacy history, retaining receipts and IDs', async () => {
  const f = fixture()
  const source = await f.read()
  const saved = await bind(f, source.chain)
  const before = structuredClone(saved)
  vi.mocked(f.runtime.listSessionChains).mockReturnValue([legacy(source.chain, 'done'), saved])
  const context = await f.read()
  expect(context.chain).toEqual(before)
  expect(context.expectedRevision).toBe(1)
  vi.mocked(f.runtime.listSessionChains).mockReturnValue([legacy(source.chain, 'launching'), saved])
  await expect(f.read()).rejects.toThrow('unfinished legacy Next plan')
})

it('allows durable recovery saves of historical duplicate owners but refuses a third admission', async () => {
  const f = fixture()
  const source = await f.read()
  const first = await bind(f, source.chain)
  const second = structuredClone(first)
  second.id = 'historical-duplicate'
  f.persistence.replaceSessionChainOutcomesAndFlush(second, 0)
  vi.mocked(f.runtime.replaceSessionChainOutcomesAndFlush).mockRestore()
  Object.assign(f.runtime, {
    store: {
      replaceSessionChainOutcomesAndFlush: f.persistence.replaceSessionChainOutcomesAndFlush.bind(
        f.persistence
      )
    }
  })
  for (const saved of [first, second]) {
    saved.outcomeSet!.continuation.state = 'unverifiable'
    expect(() => f.runtime.replaceSessionChainOutcomesAndFlush(saved, 1)).not.toThrow()
  }
  expect(
    f.persistence
      .listSessionChains()
      .every((chain) => chain.outcomeSet!.continuation.state === 'unverifiable')
  ).toBe(true)
  expect(() => f.runtime.replaceSessionChainOutcomesAndFlush({ ...first, id: 'third' }, 0)).toThrow(
    'already has a committed outcome set'
  )
  expect(f.persistence.listSessionChains()).toHaveLength(2)
})

it('fences a legacy plan that appears between source discovery and durable outcome admission', async () => {
  const f = fixture()
  const source = await f.read()
  const candidate = await bind(f, source.chain)
  vi.mocked(f.runtime.replaceSessionChainOutcomesAndFlush).mockRestore()
  const write = vi.fn()
  Object.assign(f.runtime, { store: { replaceSessionChainOutcomesAndFlush: write } })
  vi.mocked(f.runtime.listSessionChains).mockReturnValue([legacy(source.chain, 'launching')])
  expect(() => f.runtime.replaceSessionChainOutcomesAndFlush(candidate, 0)).toThrow(
    'unfinished legacy Next plan'
  )
  expect(write).not.toHaveBeenCalled()
})

it('(p) reading chainless outcome context persists no pursuit', async () => {
  const f = fixture()
  const first = await f.read()
  const second = await f.read()
  expect(first.chain.id).toBe(second.chain.id)
  expect(first.expectedRevision).toBe(0)
  expect(f.runtime.listSessionChains()).toEqual([])
  expect(f.runtime.replaceSessionChainOutcomesAndFlush).not.toHaveBeenCalled()
})

it.each(['complete', 'cancelled'] as const)(
  '(o) a later pursuit gets its own chain after %s and lookup returns the live one',
  async (state) => {
    const f = fixture()
    const source = await f.read()
    const first = await bind(f, source.chain)
    f.service.dispose()
    if (state === 'cancelled') {
      f.runtime.replaceSessionChainOutcomesAndFlush({ ...first, state: 'cancelled' }, 1)
    } else {
      f.write('report.txt', 'Verified report')
      await f.service.verify(first.id, 1, 'report', 'file')
    }
    const history = structuredClone(f.service.get(first.id))
    const next = await f.read()
    expect(next.chain.id).toBe(`${first.id}_1`)
    expect(next.expectedRevision).toBe(0)
    const saved = await bind(f, next.chain)
    f.service.dispose()
    expect(f.runtime.listSessionChains()).toHaveLength(2)
    expect(f.service.get(first.id)).toEqual(history)
    expect((await f.read()).chain.id).toBe(saved.id)
  }
)
