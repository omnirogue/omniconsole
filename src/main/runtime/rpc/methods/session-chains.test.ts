import { observeSessionOutcomeSource } from '../../session-outcome-source'
import {
  reviseSessionOutcomeSet,
  recordSessionOutcomeEvidence
} from '../../../../shared/session-outcome-state'
import { sessionOutcomeVerifiedEvidence } from '../../session-outcome-evidence'
import { sealSessionRunCompletion } from '../../../../shared/session-run-completion'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../omni-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { SESSION_CHAIN_METHODS, listSessionChainOutputFiles } from './session-chains'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('session chain RPC methods', () => {
  it('routes list, upsert and remove to the runtime store seam', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listSessionChains: vi.fn().mockReturnValue([{ id: 'chn_1' }]),
      upsertSessionChain: vi.fn().mockReturnValue({ id: 'chn_1', state: 'waiting' }),
      removeSessionChain: vi.fn().mockReturnValue(true)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_CHAIN_METHODS })

    await expect(dispatcher.dispatch(makeRequest('sessionChain.list'))).resolves.toMatchObject({
      ok: true,
      result: { chains: [{ id: 'chn_1' }] }
    })
    await expect(
      dispatcher.dispatch(makeRequest('sessionChain.upsert', { chain: { id: 'chn_1' } }))
    ).resolves.toMatchObject({ ok: true, result: { chain: { id: 'chn_1', state: 'waiting' } } })
    expect(runtime.upsertSessionChain).toHaveBeenCalledWith({ id: 'chn_1' })
    await expect(
      dispatcher.dispatch(makeRequest('sessionChain.remove', { id: 'chn_1' }))
    ).resolves.toMatchObject({ ok: true, result: { removed: true } })
    await expect(
      dispatcher.dispatch(makeRequest('sessionChain.remove', {}))
    ).resolves.toMatchObject({ ok: false })
  })

  it('lists the files a step produced under .omni/runs and refuses paths outside the workspace', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'omni-chain-'))
    tempDirs.push(workspace)
    const outputDir = join(workspace, '.omni', 'runs', 'chn_1', 'step_1')
    mkdirSync(join(outputDir, 'clips'), { recursive: true })
    writeFileSync(join(outputDir, 'manifest.md'), '# manifest')
    writeFileSync(join(outputDir, 'clips', 'intro.mp4'), 'binary')

    expect(
      listSessionChainOutputFiles({ workspacePath: workspace, chainId: 'chn_1', stepId: 'step_1' })
    ).toEqual({
      outputDir,
      files: [join(outputDir, 'clips', 'intro.mp4'), join(outputDir, 'manifest.md')],
      truncated: false
    })
    expect(
      listSessionChainOutputFiles({ workspacePath: workspace, chainId: 'chn_1', stepId: 'missing' })
    ).toMatchObject({ files: [] })

    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_CHAIN_METHODS })
    await expect(
      dispatcher.dispatch(
        makeRequest('sessionChain.outputFiles', {
          workspacePath: workspace,
          chainId: '../../etc',
          stepId: 'step_1'
        })
      )
    ).resolves.toMatchObject({ ok: false })
  })
})

it('freshly verifies the source before using cached completion to close or save a session', async () => {
  const pending = reviseSessionOutcomeSet(
    undefined,
    {
      expectedRevision: 0,
      source: 'user',
      sessionFinish: { action: 'end' },
      outcomes: [
        {
          id: 'done',
          title: 'Finish source',
          finish: 'complete',
          dependsOn: [],
          actions: [],
          conditions: [{ id: 'source', kind: 'session', target: 'tab:leaf' }]
        }
      ]
    },
    { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned', sourceReady: true },
    1
  )
  const set = recordSessionOutcomeEvidence(
    pending,
    sessionOutcomeVerifiedEvidence(
      pending.outcomes[0]!,
      pending.outcomes[0]!.conditions[0]!,
      'old-success',
      2
    )
  )
  const chain: { id: string; sourcePaneKey: string; worktreeId: string; outcomeSet: typeof set } = {
    id: 'chain',
    sourcePaneKey: 'tab:leaf',
    worktreeId: 'work',
    outcomeSet: set
  }
  const hook = vi.fn().mockReturnValue({ state: 'working' })
  const runtime = {
    getRuntimeId: () => 'runtime',
    getSessionOutcomeService: () => ({ get: () => chain, now: () => 3 }),
    resolveTerminalPane: () => ({ handle: 'source', worktreeId: 'work' }),
    getTerminalPaneKey: () => 'tab:leaf',
    getTerminalProcessIncarnation: () => 'process:1',
    getFreshAgentHookStatusForHandle: hook,
    readTerminal: async () => {
      throw new Error('host offline')
    }
  } as unknown as OrcaRuntimeService
  hook.mockReturnValue({
    state: 'done',
    stateStartedAt: 10,
    lastAssistantMessage: 'Finished latest source work.'
  })
  const original = await observeSessionOutcomeSource(runtime, chain as never, {
    successfulOnly: true
  })
  set.continuation.sourceVersion = original.version
  hook.mockReturnValue({ state: 'working' })
  const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_CHAIN_METHODS })
  const request = (verifySourceReady = false) =>
    makeRequest('sessionChain.outcomeProgress', {
      id: 'chain',
      expectedExecutionRuntimeId: 'runtime',
      ...(verifySourceReady ? { verifySourceReady } : {})
    })
  await expect(dispatcher.dispatch(request())).resolves.toMatchObject({
    ok: true,
    result: { lifecycle: 'complete' }
  })
  await expect(dispatcher.dispatch(request(true))).resolves.toMatchObject({
    ok: true,
    result: { lifecycle: 'waiting' }
  })
  // A source that cannot be read is a diagnostic and a wait, never a request for the person.
  hook.mockReturnValue(undefined)
  await expect(dispatcher.dispatch(request(true))).resolves.toMatchObject({
    ok: true,
    result: {
      lifecycle: 'waiting',
      phase: 'waiting',
      reasons: [expect.stringContaining('unverifiable')]
    }
  })
  hook.mockReturnValue({
    state: 'done',
    stateStartedAt: 10,
    lastAssistantMessage: 'Finished latest source work.'
  })
  await expect(dispatcher.dispatch(request(true))).resolves.toMatchObject({
    ok: true,
    result: { lifecycle: 'complete' }
  })
  hook.mockReturnValue({
    state: 'done',
    stateStartedAt: 20,
    lastAssistantMessage: 'Finished latest source work.'
  })
  await expect(dispatcher.dispatch(request(true))).resolves.toMatchObject({
    ok: true,
    result: {
      lifecycle: 'waiting',
      phase: 'waiting',
      reasons: [expect.stringContaining('source advanced')]
    }
  })
  // Once the run is sealed, a source that moved on afterwards is about some later run.
  chain.outcomeSet = sealSessionRunCompletion(set, { now: 4, operationId: 'op_seal' })
  await expect(dispatcher.dispatch(request(true))).resolves.toMatchObject({
    ok: true,
    result: { lifecycle: 'complete', phase: 'completed', reasons: [] }
  })
})
