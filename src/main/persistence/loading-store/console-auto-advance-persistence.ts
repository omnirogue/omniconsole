import {
  consoleAutoAdvanceOff,
  isConsoleAutoAdvanceWorkflowId,
  isConsoleAutoAdvanceWorktree,
  normalizeConsoleAutoAdvancePreferences,
  type ConsoleAutoAdvancePreference,
  type ConsoleAutoAdvanceStatus
} from '../../../shared/console-auto-advance'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'

type ConsoleAutoAdvanceRuntime = Pick<StoreRuntimeState, 'state'>

const consoleAutoAdvancePersistenceContext = Symbol('ConsoleAutoAdvancePersistence')
type ConsoleAutoAdvancePersistenceContext = {
  runtime: ConsoleAutoAdvanceRuntime
  scheduling: WriteSchedulingOperations
}

/** Person preference only: no claim, no job identity and no credential is stored here. */
export class ConsoleAutoAdvancePersistence {
  readonly [consoleAutoAdvancePersistenceContext]: ConsoleAutoAdvancePersistenceContext

  constructor(runtime: ConsoleAutoAdvanceRuntime, scheduling: WriteSchedulingOperations) {
    this[consoleAutoAdvancePersistenceContext] = { runtime, scheduling }
  }

  getConsoleAutoAdvance(workflowId: string): ConsoleAutoAdvancePreference {
    if (!isConsoleAutoAdvanceWorkflowId(workflowId)) {
      throw new Error('A valid admitted workflow is required.')
    }
    return this.rows()[workflowId] ?? consoleAutoAdvanceOff(workflowId)
  }

  listConsoleAutoAdvance(): ConsoleAutoAdvancePreference[] {
    return Object.values(this.rows())
  }

  setConsoleAutoAdvance(input: {
    workflowId: string
    enabled: boolean
    worktree?: string
    status?: ConsoleAutoAdvanceStatus
  }): ConsoleAutoAdvancePreference {
    const current = this.getConsoleAutoAdvance(input.workflowId)
    const worktree = input.worktree ?? current.worktree
    if (input.enabled && !isConsoleAutoAdvanceWorktree(worktree)) {
      throw new Error('Choose the workspace this workflow may activate its local jobs in.')
    }
    // Why the whole row is rebuilt: turning auto-advance off must clear the running status in the
    // same write, so a later read can never report "waiting" for a preference the person stopped.
    const next: ConsoleAutoAdvancePreference = input.enabled
      ? {
          workflowId: current.workflowId,
          enabled: true,
          worktree,
          status: input.status ?? current.status
        }
      : consoleAutoAdvanceOff(current.workflowId, worktree)
    const rows = { ...this.rows(), [current.workflowId]: next }
    this[consoleAutoAdvancePersistenceContext].runtime.state.consoleWorkflowAutoAdvance = rows
    scheduleSave(this[consoleAutoAdvancePersistenceContext].scheduling)
    return next
  }

  /** Status is only recorded for a preference that is still on. */
  recordConsoleAutoAdvanceStatus(
    workflowId: string,
    status: ConsoleAutoAdvanceStatus
  ): ConsoleAutoAdvancePreference {
    const current = this.getConsoleAutoAdvance(workflowId)
    if (!current.enabled) {
      return current
    }
    return this.setConsoleAutoAdvance({
      workflowId,
      enabled: true,
      worktree: current.worktree,
      status
    })
  }

  private rows(): Record<string, ConsoleAutoAdvancePreference> {
    return normalizeConsoleAutoAdvancePreferences(
      this[consoleAutoAdvancePersistenceContext].runtime.state.consoleWorkflowAutoAdvance
    )
  }
}

export function installConsoleAutoAdvancePersistenceContext(
  target: object,
  source: ConsoleAutoAdvancePersistence
): void {
  Object.defineProperty(target, consoleAutoAdvancePersistenceContext, {
    value: source[consoleAutoAdvancePersistenceContext]
  })
}
