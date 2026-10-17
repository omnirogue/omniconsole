import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import {
  assertSessionOutcomeUser,
  sessionOutcomeMutationAuthority
} from './session-outcome-authority'
import type { SessionChain } from '../../shared/session-chain-types'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.dispose()
  }
})
function fixture() {
  const f = outcomeRuntimeFixture(() => ({ body: 'done' }))
  fixtures.push(f)
  const run = f.db.createRun({
    objective: 'User-authorized source',
    coordinatorHandle: 'coord',
    coordinatorPaneKey: 'coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  })
  const task = f.db.createTask({
    runId: run.id,
    spec: 'Produce the approved report without publishing it.'
  })
  const dispatch = f.db.createStartingWorkerDispatch({
    taskId: task.id,
    creator: { kind: 'system' },
    maxDepth: 3,
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
  const chain = { sourcePaneKey: 'source', worktreeId: 'folder:outcome' } as SessionChain
  return { ...f, task, dispatch, capability, chain }
}

describe('outcome mutation authority comes from the authenticated invocation', () => {
  it('prevents an attested agent from claiming user removal or human approval authority', () => {
    const f = fixture(),
      context = { runtime: f.runtime, orchestrationCapability: f.capability }
    expect(sessionOutcomeMutationAuthority(context, f.chain, 'user')).toEqual({
      source: 'ai',
      instruction: f.task.spec
    })
    expect(() => assertSessionOutcomeUser(context)).toThrow('authenticated user interface')
  })
  it('rejects absent, forged and revoked dispatch authority even with source:user', () => {
    const f = fixture()
    expect(() => sessionOutcomeMutationAuthority({ runtime: f.runtime }, f.chain, 'user')).toThrow(
      'authenticated user interface'
    )
    expect(() =>
      sessionOutcomeMutationAuthority(
        { runtime: f.runtime, orchestrationCapability: 'forged' },
        f.chain,
        'user'
      )
    ).toThrow('does not own')
    f.db.failWorkerStart(f.dispatch.id, 'setup', 'failed')
    expect(() =>
      sessionOutcomeMutationAuthority(
        { runtime: f.runtime, orchestrationCapability: f.capability },
        f.chain,
        'user'
      )
    ).toThrow('does not own')
  })
  it('recognizes the renderer identity assigned by the main-frame IPC bridge', () => {
    const f = fixture(),
      context = { runtime: f.runtime, clientId: 'desktop-renderer', clientKind: 'runtime' as const }
    expect(sessionOutcomeMutationAuthority(context, f.chain, 'user')).toEqual({ source: 'user' })
    expect(() => assertSessionOutcomeUser(context)).not.toThrow()
  })
})

it('authenticates an ordinary source through the existing launch-token envelope and preserves its host prompt', async () => {
  const f = fixture()
  const { vi } = await import('vitest')
  const { sessionOutcomeSource } = await import('./session-outcome-source-authority')
  const paneKey = 'source'
  const evidence = {
    terminalHandle: 'source',
    paneKey,
    launchToken: 'test-launch-secret'
  }
  const attestation = vi
    .spyOn(f.runtime, 'verifyOrchestrationCompatibilityCaller')
    .mockReturnValue({
      hostScope: { kind: 'local' },
      paneKey,
      terminalHandle: 'source',
      processIncarnation: 'current',
      launchTokenHash: 'hash'
    } as never)
  vi.mocked(f.runtime.resolveTerminalPane).mockReturnValue({
    handle: 'source',
    tabId: 'source',
    leafId: 'leaf',
    ptyId: 'pty',
    connected: true,
    worktreeId: 'folder:outcome'
  })
  vi.spyOn(f.runtime, 'getSessionOutcomeSourcePrompt').mockReturnValue(
    'Produce the approved report.'
  )
  vi.mocked(f.runtime.getFreshAgentHookStatusForHandle).mockReturnValue({
    state: 'working',
    prompt: 'Display preview is not authority',
    lastAssistantMessage: null,
    interactivePrompt: null,
    stateStartedAt: 1,
    updatedAt: Date.now()
  })
  const context = { runtime: f.runtime, orchestrationCompatibilityEvidence: evidence }
  const source = await sessionOutcomeSource(context, { paneKey, worktreeId: 'folder:outcome' })
  expect(source.prompt).toBe('Produce the approved report.')
  expect(source.expectedRevision).toBe(0)
  expect(source.chain.sourceRowKey).toBe(JSON.stringify(['local', 'folder:outcome', paneKey]))
  expect(sessionOutcomeMutationAuthority(context, source.chain, 'user')).toEqual({
    source: 'ai',
    instruction: source.prompt
  })
  expect(attestation).toHaveBeenCalledWith(evidence)
  expect(() => assertSessionOutcomeUser(context)).toThrow('authenticated user interface')
  attestation.mockReturnValue(null)
  await expect(sessionOutcomeSource(context, { paneKey })).rejects.toThrow('source authority')
})

it('binds the first AI set durably and refuses a prompt change during commit before writing', async () => {
  const f = fixture()
  const base = {
    id: 'inferred',
    workspacePath: f.workspace,
    worktreeId: 'folder:outcome',
    hostId: 'local',
    sourcePaneKey: 'source',
    sourceRowKey: 'row',
    auto: true,
    steps: [],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1
  }
  const input = {
    expectedRevision: 0,
    source: 'ai' as const,
    expectedSourcePrompt: f.task.spec,
    outcomes: [
      {
        id: 'report',
        title: 'Approved report',
        finish: 'complete' as const,
        dependsOn: [],
        conditions: [
          { id: 'file', kind: 'file' as const, target: join(f.workspace, 'report.txt') }
        ],
        actions: [
          {
            id: 'produce',
            instruction: f.task.spec,
            authority: 'existing-user-authority' as const,
            agent: 'codex' as const,
            conditionIds: ['file']
          }
        ]
      }
    ]
  }
  await expect(f.service.commit(base, input, f.task.spec, () => 'changed source')).rejects.toThrow(
    'Source authority changed'
  )
  expect(f.runtime.listSessionChains()).toHaveLength(0)
  const saved = await f.service.commit(base, input, f.task.spec, () => f.task.spec)
  f.service.dispose()
  expect(saved.outcomeSet!.revision).toBe(1)
  expect(f.runtime.listSessionChains()[0]!.outcomeSet!.outcomes[0]!.actions[0]!.instruction).toBe(
    f.task.spec
  )
  expect(f.launched).toHaveLength(0)
})
