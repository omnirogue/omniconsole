import type {
  WorkflowScriptAgentRecord,
  WorkflowScriptEvent,
  WorkflowScriptRunSnapshot
} from '../../../shared/workflow-script-types'
import {
  runWorkflowScriptAgentCall,
  type WorkflowScriptAgentAnswer,
  type WorkflowScriptExecutor
} from './workflow-script-agent-call'
import type { WorkflowScriptJournal } from './workflow-script-journal'
import {
  readWorkflowScriptMeta,
  startWorkflowScript,
  WorkflowScriptError
} from './workflow-script-sandbox'
import { defaultWorkflowScriptSlots, WorkflowScriptSlots } from './workflow-script-slots'

import {
  createWorkflowGroupingPrimitives,
  WORKFLOW_PROGRAM_MAX_ITEMS
} from './workflow-program-context'

export const WORKFLOW_SCRIPT_MAX_AGENTS = 1000
export const WORKFLOW_SCRIPT_MAX_ITEMS = WORKFLOW_PROGRAM_MAX_ITEMS

export type { WorkflowScriptAgentAnswer, WorkflowScriptExecutor }

export type RunWorkflowScriptOptions = {
  source: string
  args?: unknown
  budgetTotal?: number | null
  execute: WorkflowScriptExecutor
  journal?: WorkflowScriptJournal
  maxConcurrent?: number
  maxAgents?: number
  timeoutMs?: number
  signal?: AbortSignal
  onEvent?: (event: WorkflowScriptEvent) => void
  /** Tokens charged per agent when the executor reports none. */
  tokensPerAgent?: number
  clock?: () => number
}

export async function runWorkflowScript(
  options: RunWorkflowScriptOptions
): Promise<WorkflowScriptRunSnapshot> {
  const clock = options.clock ?? Date.now
  const startedAt = clock()
  const timeoutMs = options.timeoutMs ?? 6 * 60 * 60 * 1000
  const maxAgents = options.maxAgents ?? WORKFLOW_SCRIPT_MAX_AGENTS
  const slots = new WorkflowScriptSlots(options.maxConcurrent ?? defaultWorkflowScriptSlots())
  const controller = new AbortController()
  const abort = (reason: string) => {
    if (!controller.signal.aborted) {
      controller.abort(new WorkflowScriptError(reason))
    }
  }
  options.signal?.addEventListener('abort', () => abort('cancelled'), { once: true })
  const agents: WorkflowScriptAgentRecord[] = []
  const phases: string[] = []
  const logs: string[] = []
  const occurrences = new Map<string, number>()
  let current: string | null = null
  let spent = 0
  let cached = 0
  const emit = (event: WorkflowScriptEvent) => options.onEvent?.(event)
  const record = (agent: WorkflowScriptAgentRecord, patch: Partial<WorkflowScriptAgentRecord>) => {
    Object.assign(agent, patch)
    emit({ type: 'agent', agent: { ...agent } })
  }
  const guard = () => {
    if (controller.signal.aborted) {
      throw controller.signal.reason
    }
    if (clock() - startedAt > timeoutMs) {
      abort('timed out (possible unbounded loop)')
      throw controller.signal.reason
    }
  }
  const budget = {
    total: options.budgetTotal ?? null,
    spent: () => spent,
    remaining: () =>
      options.budgetTotal == null ? Infinity : Math.max(0, options.budgetTotal - spent)
  }

  const meta = (() => {
    try {
      return readWorkflowScriptMeta(options.source)
    } catch {
      return null
    }
  })()
  const agent = (prompt: unknown, opts: Record<string, unknown> = {}): Promise<unknown> =>
    runWorkflowScriptAgentCall(prompt, opts, {
      guard,
      abort,
      agents,
      phases,
      occurrences,
      currentPhase: () => current,
      budget,
      maxAgents,
      journal: options.journal,
      execute: options.execute,
      tokensPerAgent: options.tokensPerAgent ?? 0,
      slots,
      signal: controller.signal,
      clock,
      record,
      emit,
      charge: (tokens) => {
        spent += tokens
      },
      cachedHit: () => {
        cached += 1
      }
    })

  const { parallel, pipeline } = createWorkflowGroupingPrimitives(
    guard,
    () => controller.signal.aborted
  )

  const globals = {
    agent,
    parallel,
    pipeline,
    log: (message: unknown) => {
      const text = String(message)
      logs.push(text)
      emit({ type: 'log', message: text })
    },
    phase: (title: unknown) => {
      current = String(title)
      phases.push(current)
      emit({ type: 'phase', index: phases.length, title: current })
    },
    workflow: async () => {
      throw new WorkflowScriptError('nested workflow() is not available here')
    },
    args: options.args,
    budget
  }

  const finish = (
    status: WorkflowScriptRunSnapshot['status'],
    result: unknown,
    error: string | null
  ): WorkflowScriptRunSnapshot => ({
    status,
    meta,
    phases,
    agents,
    logs,
    result,
    error,
    tokens: spent,
    cachedAgents: cached,
    durationMs: clock() - startedAt
  })

  try {
    const result = await Promise.race([
      startWorkflowScript(options.source, globals, 30_000),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          abort('timed out (possible unbounded loop)')
          reject(controller.signal.reason)
        }, timeoutMs)
        timer.unref?.()
        controller.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(controller.signal.reason)
        })
      })
    ])
    return finish('completed', result ?? null, null)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    for (const entry of agents) {
      if (entry.state === 'queued' || entry.state === 'running') {
        record(entry, { state: 'failed', endedAt: clock(), error: message })
      }
    }
    return finish(message === 'cancelled' ? 'cancelled' : 'failed', null, message)
  }
}
