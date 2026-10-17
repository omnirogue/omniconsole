import { describe, expect, it, vi } from 'vitest'
import type { OrchestrationCaller } from './build-review-rpc-call'
import { createWorker } from './build-review-pipeline-state'
import { noteWorkerStartFailure, startupBlockerFromReceipt } from './build-review-startup-blocker'

describe('startup blockers', () => {
  it.each([
    [{ startupBlocker: 'codex-hooks-review-prompt' }, 'codex-hooks-review-prompt'],
    // Rows written before the id had its own field carry it only inside the sentence.
    [{ lastError: 'Agent startup blocked: codex-trust-workspace' }, 'codex-trust-workspace'],
    [{ lastError: 'agent_prompt_stalled' }, 'agent-prompt-stalled'],
    [{ lastError: 'The worker stopped: agent_prompt_blocked' }, 'agent-prompt-stalled'],
    [{ lastError: 'Agent did not become ready (exited).' }, undefined],
    [{}, undefined]
  ])('reads %j as %s', (receipt, expected) => {
    expect(startupBlockerFromReceipt({ dispatchId: 'ctx_1', state: 'failed', ...receipt })).toBe(
      expected
    )
  })

  it('keeps the terminal handle of any failed start and reads no screen without a blocker', async () => {
    const call = vi.fn(async (method: string) =>
      method === 'orchestration.workerShow' ? { worker: { agent_terminal_handle: 'term_1' } } : {}
    ) as unknown as OrchestrationCaller
    const worker = createWorker('builder', { agent: 'claude' })
    await noteWorkerStartFailure(call, worker, {
      dispatchId: 'ctx_1',
      state: 'failed',
      lastError: 'boom'
    })
    expect(worker.terminalHandle).toBe('term_1')
    expect(worker.startupBlocker).toBeUndefined()
    expect(vi.mocked(call).mock.calls.map(([method]) => method)).toEqual([
      'orchestration.workerShow'
    ])
  })

  it("names Claude's own trust dialog when the runtime files it under the shared trust id", async () => {
    const call = vi.fn(async (method: string) =>
      method === 'orchestration.workerShow' ? { worker: { agent_terminal_handle: 'term_1' } } : {}
    ) as unknown as OrchestrationCaller
    const receipt = {
      dispatchId: 'ctx_1',
      state: 'failed',
      startupBlocker: 'codex-trust-workspace'
    }
    const claude = createWorker('builder', { agent: 'claude' })
    await noteWorkerStartFailure(call, claude, receipt)
    expect(claude.startupBlocker).toBe('claude-folder-trust')
    const codex = createWorker('reviewer', { agent: 'codex' })
    await noteWorkerStartFailure(call, codex, receipt)
    expect(codex.startupBlocker).toBe('codex-trust-workspace')
  })

  it('reads the rendered screen, not the stream, to recognise a stalled Claude start', async () => {
    const call = vi.fn(async (method: string) =>
      method === 'orchestration.workerShow'
        ? { worker: { agent_terminal_handle: 'term_1' } }
        : { terminal: { tail: ['Do you trust the files in this folder?'] } }
    ) as unknown as OrchestrationCaller
    const worker = createWorker('builder', { agent: 'claude' })
    await noteWorkerStartFailure(call, worker, {
      dispatchId: 'ctx_1',
      state: 'failed',
      lastError: 'agent_prompt_stalled'
    })
    expect(worker.startupBlocker).toBe('claude-folder-trust')
    expect(vi.mocked(call)).toHaveBeenCalledWith('terminal.read', {
      terminal: 'term_1',
      limit: 60,
      screen: true
    })
  })

  it('does not read a Codex screen for a Claude-only prompt, and survives a failed read', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'orchestration.workerShow') {
        throw new Error('gone')
      }
      return {}
    }) as unknown as OrchestrationCaller
    const worker = createWorker('builder', { agent: 'codex' })
    await noteWorkerStartFailure(call, worker, {
      dispatchId: 'ctx_1',
      state: 'failed',
      lastError: 'agent_prompt_stalled'
    })
    expect(worker.terminalHandle).toBeNull()
    expect(worker.startupBlocker).toBe('agent-prompt-stalled')
  })
})
