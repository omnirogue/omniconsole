import { captureAutomationRunDefinition } from '../../../shared/automation-run-definition'
import { captureAutomationDeliveryHost } from './automation-delivery-host'
import { randomUUID } from 'node:crypto'
import {
  isFinalAutomationRunStatus,
  type AutomationRunOptions,
  type Automation,
  type AutomationDispatchResult,
  type AutomationRun,
  type AutomationRunTrigger
} from '../../../shared/automations-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  nextAutomationRunNumber,
  pruneAutomationRuns
} from '../../../shared/automation-run-retention'
import { applyAutomationRunProviderSessionResult } from '../../../shared/automation-run-provider-session'
import {
  normalizeAutomationPrecheckResult,
  normalizeAutomationRunOutputSnapshot,
  normalizeAutomationRunTerminalPaneKey,
  normalizeAutomationRunTerminalPtyId,
  normalizeAutomationRunWorkspaceDisplayName
} from './automation-context-migration'

export type AutomationRunOperations = {
  state: PersistedState
  storageAuthority?: 'desktop' | 'runtime'
  flush: () => void
  recordManualRun: () => void
  getWorkspaceDisplayName: (workspaceId: string | null | undefined) => string | null
}

function touchAutomation(state: PersistedState, automationId: string, now: number): void {
  if (!state.automations.some((entry) => entry.id === automationId)) {
    return
  }
  state.automations = state.automations.map((entry) =>
    entry.id === automationId ? { ...entry, lastRunAt: now, updatedAt: now } : entry
  )
}

export function listAutomationRuns(state: PersistedState, automationId?: string): AutomationRun[] {
  const runs = state.automationRuns ?? []
  return [...(automationId ? runs.filter((run) => run.automationId === automationId) : runs)]
    .map((run) => ({
      ...run,
      precheckResult: normalizeAutomationPrecheckResult(run.precheckResult)
    }))
    .sort((left, right) => right.createdAt - left.createdAt)
}

export function createAutomationRun(
  operations: AutomationRunOperations,
  automation: Automation,
  scheduledFor: number,
  trigger: AutomationRunTrigger = 'scheduled',
  options?: AutomationRunOptions
): AutomationRun {
  const existing = (operations.state.automationRuns ?? []).find(
    (run) => run.automationId === automation.id && run.scheduledFor === scheduledFor
  )
  if (existing) {
    return existing
  }
  const now = Date.now()
  // Why: retention prunes old runs, so the retained count isn't the ordinal — carry the number forward from the newest survivor.
  const runNumber = nextAutomationRunNumber(
    (operations.state.automationRuns ?? []).filter((run) => run.automationId === automation.id)
  )
  const run: AutomationRun = {
    id: randomUUID(),
    automationId: automation.id,
    deliveryVersion: 1,
    deliveryHostId: captureAutomationDeliveryHost(
      operations.state,
      automation,
      operations.storageAuthority
    ),
    definitionSnapshot: captureAutomationRunDefinition(automation),
    runNumber,
    runContext: automation.runContext ?? null,
    sourceContext: automation.sourceContext ?? null,
    title: `${automation.name} run ${runNumber}${options?.titleSuffix !== undefined ? ` · ${options.titleSuffix}` : ''}`,
    promptOverride: options?.promptOverride ?? null,
    scheduledFor,
    status: 'pending',
    trigger,
    workspaceId: automation.workspaceId,
    workspaceDisplayName: operations.getWorkspaceDisplayName(automation.workspaceId),
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: null,
    dispatchedAt: null,
    createdAt: now
  }
  operations.state.automationRuns = pruneAutomationRuns([
    ...(operations.state.automationRuns ?? []),
    run
  ])
  if (trigger === 'manual') {
    operations.recordManualRun()
  }
  operations.flush()
  return run
}

export function recordRepeatedAutomationSkip(
  operations: AutomationRunOperations,
  automationId: string,
  error: string,
  scheduledFor: number
): AutomationRun | null {
  const runs = operations.state.automationRuns ?? []
  const latest = runs
    .filter((run) => run.automationId === automationId)
    .reduce<AutomationRun | null>(
      (newest, run) => (!newest || run.createdAt > newest.createdAt ? run : newest),
      null
    )
  if (
    !latest ||
    latest.status !== 'skipped_unavailable' ||
    latest.trigger !== 'scheduled' ||
    latest.error !== error
  ) {
    return null
  }
  if ((latest.lastOccurrenceAt ?? latest.scheduledFor) === scheduledFor) {
    return latest
  }
  const now = Date.now()
  const updated: AutomationRun = {
    ...latest,
    occurrenceCount: (latest.occurrenceCount ?? 1) + 1,
    lastOccurrenceAt: scheduledFor
  }
  // Replaced, not patched in place: the list projection caches on array identity.
  operations.state.automationRuns = runs.map((run) => (run.id === latest.id ? updated : run))
  touchAutomation(operations.state, automationId, now)
  operations.flush()
  return updated
}

export function updateAutomationRun(
  operations: AutomationRunOperations,
  result: AutomationDispatchResult,
  terminalProcessIncarnation?: string
): AutomationRun {
  const index = (operations.state.automationRuns ?? []).findIndex(
    (entry) => entry.id === result.runId
  )
  if (index === -1) {
    throw new Error('Automation run not found.')
  }
  const now = Date.now()
  const current = operations.state.automationRuns[index]
  // Why: a late write (a renderer `dispatched` after the watcher stranded the run)
  // must not reopen a settled run, or it could be observed and finished twice.
  if (isFinalAutomationRunStatus(current.status) && !isFinalAutomationRunStatus(result.status)) {
    console.warn('[automations] ignored a late write to a settled run', result.runId, result.status)
    return current
  }
  const workspaceId = result.workspaceId ?? current.workspaceId
  const workspaceDisplayName = Object.hasOwn(result, 'workspaceDisplayName')
    ? normalizeAutomationRunWorkspaceDisplayName(result.workspaceDisplayName ?? null)
    : null
  const updated: AutomationRun = applyAutomationRunProviderSessionResult(
    {
      ...current,
      // This internal owner argument is never copied from renderer/public dispatch input,
      // and cannot rebind a retained run after an app restart or late provider write.
      ...(current.dispatchedAt === null &&
      result.status === 'dispatched' &&
      typeof terminalProcessIncarnation === 'string' &&
      terminalProcessIncarnation.length > 0 &&
      terminalProcessIncarnation.length <= 8192
        ? { terminalProcessIncarnation }
        : {}),
      status: result.status,
      launchOutcome:
        result.status === 'completed'
          ? undefined
          : result.launchOutcome === 'unverifiable'
            ? 'unverifiable'
            : result.launchOutcome === null
              ? undefined
              : current.launchOutcome,
      deliveryResults: result.deliveryResults ?? current.deliveryResults,
      ownsTerminal: result.ownsTerminal ?? current.ownsTerminal,
      workspaceId,
      workspaceDisplayName:
        workspaceDisplayName ??
        normalizeAutomationRunWorkspaceDisplayName(current.workspaceDisplayName ?? null) ??
        operations.getWorkspaceDisplayName(workspaceId),
      terminalSessionId: Object.hasOwn(result, 'terminalSessionId')
        ? (result.terminalSessionId ?? null)
        : current.terminalSessionId,
      terminalPaneKey: Object.hasOwn(result, 'terminalPaneKey')
        ? normalizeAutomationRunTerminalPaneKey(result.terminalPaneKey)
        : normalizeAutomationRunTerminalPaneKey(current.terminalPaneKey),
      terminalPtyId: Object.hasOwn(result, 'terminalPtyId')
        ? normalizeAutomationRunTerminalPtyId(result.terminalPtyId)
        : normalizeAutomationRunTerminalPtyId(current.terminalPtyId),
      outputSnapshot: Object.hasOwn(result, 'outputSnapshot')
        ? normalizeAutomationRunOutputSnapshot(result.outputSnapshot)
        : normalizeAutomationRunOutputSnapshot(current.outputSnapshot),
      precheckResult: Object.hasOwn(result, 'precheckResult')
        ? normalizeAutomationPrecheckResult(result.precheckResult)
        : normalizeAutomationPrecheckResult(current.precheckResult),
      usage: Object.hasOwn(result, 'usage') ? (result.usage ?? null) : (current.usage ?? null),
      error: result.error ?? null,
      startedAt: current.startedAt ?? now,
      // Why `?? now` and not `now`: a follow-up write that only adds the pane's provider
      // thread keeps status 'dispatched'; re-stamping would shift the usage window.
      dispatchedAt:
        result.status === 'dispatched' ? (current.dispatchedAt ?? now) : current.dispatchedAt
    },
    result
  )
  // Replaced, not patched in place: the list projection caches on array identity.
  operations.state.automationRuns = operations.state.automationRuns.map((run) =>
    run.id === result.runId ? updated : run
  )
  touchAutomation(operations.state, updated.automationId, now)
  operations.flush()
  return updated
}

export function snapshotAutomationRunWorkspaceDisplayName(
  operations: AutomationRunOperations,
  workspaceId: string,
  displayName: string
): number {
  const normalizedDisplayName = normalizeAutomationRunWorkspaceDisplayName(displayName)
  if (!normalizedDisplayName) {
    return 0
  }
  let updatedCount = 0
  operations.state.automationRuns = (operations.state.automationRuns ?? []).map((run) => {
    if (run.workspaceId !== workspaceId || run.workspaceDisplayName === normalizedDisplayName) {
      return run
    }
    updatedCount += 1
    return { ...run, workspaceDisplayName: normalizedDisplayName }
  })
  if (updatedCount > 0) {
    operations.flush()
  }
  return updatedCount
}
