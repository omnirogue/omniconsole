import type { JsonSchema } from '../../../shared/json-schema-validate'
import { WorkflowScriptError } from './workflow-script-sandbox'
import type { SelectedFinding } from './presets/discover-assessment'

export const WORKFLOW_PROGRAM_MAX_ITEMS = 4096

export type WorkflowProgramCall = {
  id: string
  prompt: string
  schema: JsonSchema
  seatId: string
  dependencies: string[]
  /** Serializable validator identity for a working agent's same-Dispatch result gate. */
  semantic?: WorkflowProgramSemanticContract
  validateSemantics: (value: unknown) => string | null
  /**
   * 'text': the provider answers in plain text and the host wraps its final message as
   * `{ markdown }` before schema validation. Absent: native structured output (legacy default).
   * Part of call identity only when set, so older revisions keep their digests.
   */
  output?: 'text'
  /** Per-call process timeout. Not part of call identity. */
  timeoutMs?: number
}

export type WorkflowProgramSemanticContract =
  | { kind: 'none' }
  | { kind: 'council-ballot'; expectedLabels: string[] }
  | { kind: 'discover-clusters'; expectedIds: string[] }
  | { kind: 'discover-vote' }
  | { kind: 'discover-ranking'; expectedIds: string[] }
  | { kind: 'discover-reviewed-ranking'; survivors: SelectedFinding[] }

export type WorkflowProgramPort = {
  agent: (call: WorkflowProgramCall) => Promise<unknown>
  phase: (title: string) => void
  log: (message: string) => void
  guard: () => void
  isFatal: (error: unknown) => boolean
}

/** Bundled programs receive host functions, never source text or a VM realm. */
export function createWorkflowProgramContext(port: WorkflowProgramPort) {
  return {
    agent: port.agent,
    phase: port.phase,
    log: port.log,
    /** Throws once the run is stopping or paused: nothing new may start. */
    guard: port.guard,
    ...createWorkflowGroupingPrimitives(port.guard, port.isFatal)
  }
}

export type WorkflowProgramContext = ReturnType<typeof createWorkflowProgramContext>

export function createWorkflowGroupingPrimitives(
  guard: () => void,
  isFatal: (error: unknown) => boolean
) {
  async function settle<T>(tasks: (() => Promise<T>)[]): Promise<(T | null)[]> {
    const results = await Promise.allSettled(tasks.map((task) => task()))
    const fatal = results.find((result) => result.status === 'rejected' && isFatal(result.reason))
    if (fatal?.status === 'rejected') {
      throw fatal.reason
    }
    return results.map((result) => (result.status === 'fulfilled' ? result.value : null))
  }

  async function parallel(thunks: unknown): Promise<unknown[]> {
    guard()
    if (!Array.isArray(thunks)) {
      throw new WorkflowScriptError('parallel() expects an array of thunks')
    }
    if (thunks.length > WORKFLOW_PROGRAM_MAX_ITEMS) {
      throw new WorkflowScriptError(
        `parallel() given more than ${WORKFLOW_PROGRAM_MAX_ITEMS} items`
      )
    }
    if (thunks.some((thunk) => typeof thunk !== 'function')) {
      throw new WorkflowScriptError(
        'parallel() expects thunks, got a non-function (missing `() =>`?)'
      )
    }
    return settle(
      thunks.map((thunk) => async () => {
        guard()
        return await thunk()
      })
    )
  }

  async function pipeline(items: unknown, ...stages: unknown[]): Promise<unknown[]> {
    guard()
    if (!Array.isArray(items)) {
      throw new WorkflowScriptError('pipeline() expects an array of items')
    }
    if (items.length > WORKFLOW_PROGRAM_MAX_ITEMS) {
      throw new WorkflowScriptError(
        `pipeline() given more than ${WORKFLOW_PROGRAM_MAX_ITEMS} items`
      )
    }
    if (stages.some((stage) => typeof stage !== 'function')) {
      throw new WorkflowScriptError('pipeline() stages must be functions')
    }
    return settle(
      items.map((item, index) => async () => {
        let acc: unknown = item
        for (const stage of stages as ((a: unknown, b: unknown, c: number) => unknown)[]) {
          guard()
          acc = await stage(acc, item, index)
        }
        return acc
      })
    )
  }

  return { parallel, pipeline }
}
