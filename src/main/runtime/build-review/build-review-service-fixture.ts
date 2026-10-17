import { vi } from 'vitest'
import type { OrcaRuntimeService } from '../omni-runtime'
import type { OrchestrationCaller } from './build-review-rpc-call'

type Call = { method: string; params: Record<string, unknown> }

export function createFakeRuntime() {
  const changed: unknown[] = []
  const runtime = {
    getOrchestrationDb: () => ({}),
    getRuntimeId: () => 'runtime_1',
    showManagedTerminalWorkspace: vi.fn(async () => ({ id: 'repo::/wt', path: process.cwd() })),
    createTerminal: vi.fn(async () => ({ handle: 'term_coord' })),
    getTerminalPaneKey: vi.fn(() => 'pane_coord'),
    closeTerminal: vi.fn(async () => ({ ptyKilled: true })),
    notifyBuildReviewChanged: vi.fn((payload: unknown) => changed.push(payload))
  }
  return { runtime: runtime as unknown as OrcaRuntimeService, changed, fake: runtime }
}

/** Scripted orchestration: worker_done arrives on the first check after each worker-start. */
export function createScriptedCaller(script: {
  builderOutcome: 'succeeded' | 'failed'
  /** What the builder's worker_done lists as touched (default two files). */
  builderFiles?: string
  reviewerOutcome?: 'succeeded' | 'failed'
  bodies?: string[]
  beforeWorkerStart?: () => Promise<void>
  workerStartState?: string
  /** Receipts for successive worker starts; a start past the list is ready. */
  startReceipts?: Record<string, unknown>[]
  /** The worker terminal's last lines, as `terminal.read` returns them. */
  screen?: string[]
}) {
  const calls: Call[] = []
  let dispatchSeq = 0
  const pendingDone: string[] = []
  const caller: OrchestrationCaller = async <T>(
    method: string,
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ) => {
    calls.push({ method, params })
    if (method === 'orchestration.workerStart' && script.beforeWorkerStart) {
      await script.beforeWorkerStart()
    }
    if (method === 'orchestration.check' && options?.signal?.aborted) {
      throw new Error('aborted')
    }
    switch (method) {
      case 'orchestration.runCreate':
        return {
          run: { id: 'run_1' },
          ...(params.hubTaskId ? { projectionTaskId: 'task_projection' } : {})
        } as T
      case 'orchestration.taskCreate':
        return { task: { id: `task_${calls.filter((c) => c.method === method).length}` } } as T
      case 'orchestration.workerStart': {
        const dispatchId = `ctx_${++dispatchSeq}`
        const receipt = {
          dispatchId,
          state: script.workerStartState ?? 'ready',
          ...script.startReceipts?.[dispatchSeq - 1]
        }
        if (receipt.state === 'ready') {
          pendingDone.push(dispatchId)
        }
        return receipt as T
      }
      case 'terminal.read':
        return { terminal: { tail: script.screen ?? [] } } as T
      case 'orchestration.workerShow':
        return {
          worker: { state: 'ready', agent_terminal_handle: `term_${params.dispatch as string}` }
        } as T
      case 'orchestration.workerStop':
        return { state: 'stopped' } as T
      case 'orchestration.workerRelease':
        return { state: 'released' } as T
      case 'orchestration.check': {
        const dispatchId = pendingDone.shift()
        if (!dispatchId) {
          return { messages: [], count: 0, deliveryId: null, timedOut: true } as T
        }
        const outcome =
          dispatchId === 'ctx_1' ? script.builderOutcome : (script.reviewerOutcome ?? 'succeeded')
        return {
          count: 1,
          deliveryId: `dlv_${dispatchId}`,
          messages: [
            {
              id: `msg_${dispatchId}`,
              from_handle: `term_${dispatchId}`,
              type: 'worker_done',
              subject: `${dispatchId} done`,
              body:
                script.bodies?.[Number(dispatchId.slice(4)) - 1] ??
                (dispatchId === 'ctx_1' ? 'changed things' : 'VERDICT: APPROVE'),
              payload: JSON.stringify({
                dispatchId,
                outcome,
                filesModified:
                  dispatchId === 'ctx_1' && script.builderFiles !== undefined
                    ? script.builderFiles
                    : 'src/a.ts,src/b.ts'
              })
            }
          ]
        } as T
      }
      default:
        return {} as T
    }
  }
  return { caller, calls }
}
