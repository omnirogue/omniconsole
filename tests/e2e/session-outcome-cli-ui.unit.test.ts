import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { OUTCOME_HANDLERS } from '../../src/cli/handlers/outcome'
import type { HandlerContext } from '../../src/cli/dispatch'
import { outcomeRuntimeFixture } from '../../src/main/runtime/session-outcome-runtime-test-fixture'
import { SESSION_CHAIN_METHODS } from '../../src/main/runtime/rpc/methods/session-chains'
import type { RpcContext } from '../../src/main/runtime/rpc/core'
import type { SessionChain } from '../../src/shared/session-chain-types'
import { sessionOutcomeDefinition } from '../../src/shared/session-outcome-types'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.dispose()
  }
  vi.unstubAllEnvs()
})

function fixture() {
  const f = outcomeRuntimeFixture(() => ({ body: 'Worked' }))
  fixtures.push(f)
  f.service.dispose()
  vi.spyOn(f.service, 'start').mockImplementation(() => {})
  for (const name of [
    'ORCA_PANE_KEY',
    'ORCA_WORKTREE_ID',
    'ORCA_AGENT_LAUNCH_TOKEN',
    'ORCA_AGENT_SESSION_ID'
  ]) {
    vi.stubEnv(name, '')
  }
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const postNote = vi.fn(async () => ({ ok: true as const, data: { id: 'note-1' } }))
  vi.spyOn(f.service, 'taskAttachment').mockResolvedValue({
    source: 'user',
    cardAccess: { baseUrl: 'https://hub.invalid', bearer: 'test' },
    loadChain: (id) => f.runtime.listSessionChains().find((chain) => chain.id === id),
    persistence: f.runtime,
    poster: {
      now: () => 10,
      postNote,
      postEvidence: vi.fn(async () => ({ ok: true as const, data: {} })),
      attachSessionToTask: vi.fn(async () => ({ attached: true }))
    }
  })
  const chain: SessionChain = {
    id: 'chain',
    sourcePaneKey: 'pane',
    sourceRowKey: 'row',
    worktreeId: 'folder:outcome',
    workspacePath: f.workspace,
    hostId: 'local',
    auto: true,
    steps: [{ id: 'v1', agent: 'codex', prompt: 'Write result.', status: 'queued' }],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1
  }
  const definition = {
    id: 'result',
    title: 'Result',
    finish: 'complete' as const,
    dependsOn: [],
    actions: [],
    stepIds: ['v1'],
    conditions: [{ id: 'file', kind: 'file' as const, target: join(f.workspace, 'result.txt') }]
  }
  const context: RpcContext = {
    runtime: f.runtime,
    clientKind: 'runtime',
    pairedDeviceId: 'paired-user'
  }
  const call = vi.fn(async (name: string, params?: unknown, options?: object) => {
    const method = SESSION_CHAIN_METHODS.find((entry) => entry.name === name)!
    const result = await method.handler(method.params ? method.params.parse(params) : undefined, {
      ...context,
      ...options
    })
    return { id: 'rpc', ok: true, result }
  })
  const cli = (flags: Record<string, string>) =>
    ({
      client: { call },
      flags: new Map(Object.entries(flags)),
      cwd: f.workspace,
      json: true
    }) as unknown as HandlerContext
  const body = (value: unknown) => {
    f.write('body.json', JSON.stringify(value))
    return join(f.workspace, 'body.json')
  }
  return { ...f, chain, definition, call, cli, body, postNote, context }
}

it('(m) CLI commit --task and UI use the identical strict commit and attach operations', async () => {
  const f = fixture()
  await OUTCOME_HANDLERS['outcome commit']!(
    f.cli({
      task: 'btk_card1234',
      'body-file': f.body({ chain: f.chain, outcomes: [f.definition] })
    })
  )
  const saved = f.service.get('chain')
  expect(saved.outcomeSet!.outcomes[0]!.taskRef).toMatchObject({
    taskId: 'btk_card1234',
    postedNoteId: 'note-1'
  })
  expect(saved.outcomeSet!.continuation.taskId).toBeUndefined()
  expect(f.call).toHaveBeenCalledWith(
    'sessionChain.commitOutcomes',
    expect.objectContaining({
      source: 'user',
      taskRef: expect.objectContaining({ taskId: 'btk_card1234' })
    }),
    expect.anything()
  )
  await OUTCOME_HANDLERS['outcome attach']!(f.cli({ id: 'chain', task: 'btk_other1234' }))
  expect(f.service.get('chain').outcomeSet!.outcomes[0]!.taskRef?.taskId).toBe('btk_other1234')
  const attach = SESSION_CHAIN_METHODS.find(
    (method) => method.name === 'sessionChain.attachOutcome'
  )!
  await attach.handler(
    attach.params!.parse({
      id: 'chain',
      outcomeId: 'result',
      taskId: 'btk_card1234',
      expectedRevision: saved.outcomeSet!.revision
    }),
    { runtime: f.runtime, clientId: 'desktop-renderer' }
  )
  expect(f.service.get('chain').outcomeSet!.outcomes[0]!.taskRef?.taskId).toBe('btk_card1234')
  expect(f.service.get('chain').steps).toEqual(saved.steps)
})

it('(n) CLI --supersede accepts the renderer payload retaining v1 alongside new nodes', async () => {
  const f = fixture()
  const saved = await f.service.commit(f.chain, {
    source: 'user',
    expectedRevision: 0,
    outcomes: [f.definition]
  })
  const next = {
    ...saved,
    planVersion: 2,
    steps: [...saved.steps, { id: 'v2', agent: 'codex', prompt: 'New strategy.', status: 'queued' }]
  }
  await OUTCOME_HANDLERS['outcome commit']!(
    f.cli({
      supersede: 'Use another strategy',
      'body-file': f.body({
        chain: next,
        outcomes: [
          { ...sessionOutcomeDefinition(saved.outcomeSet!.outcomes[0]!), stepIds: ['v2'] }
        ],
        expectedRevision: 1,
        planVersion: 2
      })
    })
  )
  expect(f.service.get('chain')).toMatchObject({
    planVersion: 2,
    steps: [
      { id: 'v1', status: 'skipped', supersededBy: 2 },
      { id: 'v2', planVersion: 2 }
    ]
  })
})

it('(m) RPC refuses invalid card ids and agent task-filing assertions before mutation', async () => {
  const f = fixture()
  await f.service.commit(f.chain, { source: 'user', expectedRevision: 0, outcomes: [f.definition] })
  const method = SESSION_CHAIN_METHODS.find((entry) => entry.name === 'sessionChain.attachOutcome')!
  expect(() =>
    method.params!.parse({
      id: 'chain',
      outcomeId: 'result',
      taskId: 'task_worker',
      expectedRevision: 1
    })
  ).toThrow()
  await expect(
    method.handler(
      {
        id: 'chain',
        outcomeId: 'result',
        taskId: 'btk_card1234',
        expectedRevision: 1,
        expectedExecutionRuntimeId: f.runtime.getRuntimeId()
      },
      { ...f.context, orchestrationCapability: 'worker' }
    )
  ).rejects.toThrow('authenticated user interface')
  expect(f.postNote).not.toHaveBeenCalled()
})

it('(p) CLI outcome context and UI source reads persist nothing for an ordinary prompt', async () => {
  const f = fixture()
  const task = f.db.createTask({ spec: 'What does this function do?' })
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
  vi.mocked(f.runtime.resolveTerminalPane).mockReturnValue({
    handle: 'source',
    connected: true,
    tabId: 'tab',
    leafId: 'leaf',
    ptyId: 'pty',
    worktreeId: 'folder:outcome'
  })
  vi.stubEnv('ORCA_PANE_KEY', f.runtime.getTerminalPaneKey('source')!)
  vi.stubEnv('ORCA_WORKTREE_ID', 'folder:outcome')
  await OUTCOME_HANDLERS['outcome context']!(f.cli({ 'dispatch-capability': capability }))
  expect(f.runtime.listSessionChains()).toEqual([])
  expect(f.runtime.replaceSessionChainOutcomesAndFlush).not.toHaveBeenCalled()
  const source = SESSION_CHAIN_METHODS.find((entry) => entry.name === 'sessionChain.outcomeSource')!
  await source.handler(
    { paneKey: f.runtime.getTerminalPaneKey('source')!, worktreeId: 'folder:outcome' },
    { ...f.context, orchestrationCapability: capability }
  )
  expect(f.runtime.listSessionChains()).toEqual([])
})
