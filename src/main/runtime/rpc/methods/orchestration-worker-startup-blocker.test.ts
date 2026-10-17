import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../../shared/runtime-terminal-contracts'
import { OrcaRuntimeService } from '../../omni-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'
import {
  WorkerStartupBlockedError,
  withWorkerStartupBlocker,
  workerReadinessFailure,
  workerStartupBlocker
} from './orchestration-worker-startup-blocker'

describe('worker startup blocker', () => {
  it('keeps the sentence people read and carries the id beside it', () => {
    const failure = workerReadinessFailure({
      blockedReason: 'codex-hooks-review-prompt',
      status: 'running'
    })

    expect(failure).toBeInstanceOf(WorkerStartupBlockedError)
    expect(failure.message).toBe('Agent startup blocked: codex-hooks-review-prompt')
    expect(workerStartupBlocker(failure)).toBe('codex-hooks-review-prompt')
  })

  it('names no blocker for a wait that simply never became ready', () => {
    const failure = workerReadinessFailure({ status: 'running' })

    expect(failure.message).toBe('Agent did not become ready (running).')
    expect(workerStartupBlocker(failure)).toBeUndefined()
  })

  it('never takes a blocker id out of prose', () => {
    // The same sentence from any other thrower is a sentence, not a structured fact.
    const lookalike = new Error('Agent startup blocked: codex-trust-workspace')

    expect(workerStartupBlocker(lookalike)).toBeUndefined()
    expect(withWorkerStartupBlocker({ state: 'failed' }, lookalike)).toEqual({ state: 'failed' })
  })

  it('adds the id to a failed receipt only when the failure named one', () => {
    const receipt = { state: 'failed', lastError: 'Agent startup blocked: codex-cwd-prompt' }

    expect(
      withWorkerStartupBlocker(receipt, new WorkerStartupBlockedError('codex-cwd-prompt'))
    ).toEqual({ ...receipt, startupBlocker: 'codex-cwd-prompt' })
    expect(withWorkerStartupBlocker(receipt, new Error('terminal spawn rejected'))).toBe(receipt)
  })
})

describe('federated worker startup blocker', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    vi.restoreAllMocks()
  })

  async function attachWithReadiness(
    wait: Pick<RuntimeTerminalWait, 'blockedReason'> &
      Partial<Pick<RuntimeTerminalWait, 'satisfied'>>,
    screen?: string[]
  ): Promise<Record<string, unknown>> {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::remote-worktree'
    } as never)
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_remote_worker',
      worktreeId: 'repo::remote-worktree',
      title: 'worker'
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_remote_worker',
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      exitCode: null,
      ...wait
    })
    const sendPrompt = vi.spyOn(runtime, 'sendTerminalAgentPrompt')
    if (screen) {
      vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
        tail: screen,
        source: 'screen'
      } as never)
    }
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.federationAttachStart'
    )
    if (!method) {
      throw new Error('federationAttachStart method is not registered')
    }

    const result = (await method.handler(
      method.params!.parse({
        dispatchId: 'ctx_remote',
        taskId: 'task_remote',
        taskSpec: 'remote codex worker',
        depth: 1,
        protocolVersion: 3,
        worktree: 'repo::remote-worktree',
        agent: 'codex'
      }),
      {
        runtime,
        orchestrationMutation: {
          callerFingerprint: 'home_peer',
          requestId: 'request_remote',
          method: 'orchestration.federationAttachStart',
          payloadHash: 'remote_payload'
        }
      }
    )) as Record<string, unknown>
    expect(sendPrompt).not.toHaveBeenCalled()
    return result
  }

  it('returns the blocker id as its own field on the failed attach receipt', async () => {
    const result = await attachWithReadiness({ blockedReason: 'codex-trust-workspace' })

    expect(result).toMatchObject({
      dispatchId: 'ctx_remote',
      state: 'failed',
      failedStage: 'agent_readiness',
      lastError: 'Agent startup blocked: codex-trust-workspace',
      startupBlocker: 'codex-trust-workspace'
    })
    expect(db?.getRemoteDispatchAttachment('ctx_remote')).toMatchObject({
      state: 'failed',
      last_error: 'Agent startup blocked: codex-trust-workspace'
    })
  })

  it('claims no blocker when the remote agent simply never became ready', async () => {
    const result = await attachWithReadiness({})

    expect(result).toMatchObject({
      state: 'failed',
      failedStage: 'agent_readiness',
      lastError: 'Agent did not become ready (running).'
    })
    expect(result).not.toHaveProperty('startupBlocker')
  })

  it('does not type a dispatch into a visible updater even when the readiness wait passed', async () => {
    const result = await attachWithReadiness({ satisfied: true }, [
      '› Ask Codex to do anything',
      '✨ Update available! 0.159.2 -> 0.160.1',
      '› 1. Update now (runs `npm install -g @openai/codex`)',
      '  2. Skip',
      'Press enter to continue'
    ])
    expect(result).toMatchObject({
      state: 'failed',
      failedStage: 'agent_readiness',
      startupBlocker: 'codex-update-prompt'
    })
    expect(db?.getRemoteDispatchAttachment('ctx_remote')).toMatchObject({
      state: 'failed',
      last_error: 'Agent startup blocked: codex-update-prompt'
    })
  })
})
