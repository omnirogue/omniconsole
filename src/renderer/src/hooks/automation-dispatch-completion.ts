import {
  createAutomationRunOutputSnapshotBuffer,
  selectAutomationRunOutputSnapshot
} from '@/components/automations/automation-run-output-snapshot'
import { useAppStore } from '@/store'
import type {
  AutomationDispatchResult,
  AutomationPrecheckResult,
  AutomationRun
} from '../../../shared/automations-types'
import type {
  AutomationRunProviderSession,
  AutomationRunResume
} from '../../../shared/automation-run-resume-types'
import type { AgentStateHistoryEntry, AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { selectAutomationRunProviderSession } from '@/lib/automation-run-provider-session-observation'
import { confirmAutomationThreadResume } from '@/lib/automation-thread-resume'
import {
  selectAutomationAgentStatusEntryChange,
  UNCHANGED_AUTOMATION_AGENT_STATUS_ENTRY
} from './automation-agent-status-entry-change'
import type { Worktree } from '../../../shared/worktree/types'

type MarkDispatchResult = (result: AutomationDispatchResult) => Promise<void>

export function createAutomationDispatchCompletion(args: {
  run: AutomationRun
  agentId: TuiAgent
  worktree: Worktree
  precheckResult: AutomationPrecheckResult | null
  markDispatchResult: MarkDispatchResult
  releaseTerminalOwnership: () => void
  finalizeTerminalOwnership: () => boolean
}) {
  const outputSnapshotBuffer = createAutomationRunOutputSnapshotBuffer()
  let latestAssistantMessage: string | null = null
  const getOutputSnapshot = () =>
    selectAutomationRunOutputSnapshot(latestAssistantMessage, outputSnapshotBuffer.snapshot())
  let dispatchMarked = false
  let pendingExitCode: number | null = null
  let pendingDone = false
  let pendingFailure: string | null = null
  let settling = false
  let completionMarked = false
  let unsubscribeAgentStatus = (): void => {}
  let unsubscribeSessionObserver = (): void => {}
  let releaseReuseDispatchTab = (): void => {}
  // Why: the hook names the pane's provider thread some time after dispatch; the run
  // keeps it so a later run whose pane is gone can resume this thread.
  let providerSession: AutomationRunProviderSession | null = null
  let threadResume: AutomationRunResume | null = null
  const providerSessionFields = (): Pick<
    AutomationDispatchResult,
    'providerSession' | 'resume'
  > => ({
    ...(providerSession ? { providerSession } : {}),
    ...(threadResume ? { resume: threadResume } : {})
  })
  const noteProviderSession = (entry: AgentStatusEntry): void => {
    const observed = selectAutomationRunProviderSession(entry, args.agentId)
    if (!observed || observed.providerSessionId === providerSession?.providerSessionId) {
      return
    }
    providerSession = observed
    if (threadResume) {
      threadResume = confirmAutomationThreadResume(threadResume, { id: observed.providerSessionId })
    }
    if (!dispatchMarked || completionMarked || settling) {
      return
    }
    settleLateResult(
      args.markDispatchResult({
        runId: args.run.id,
        status: 'dispatched',
        ...providerSessionFields()
      })
    )
  }
  const cleanupRunObservers = (): void => {
    unsubscribeAgentStatus()
    unsubscribeSessionObserver()
    releaseReuseDispatchTab()
    unsubscribeAgentStatus = (): void => {}
    unsubscribeSessionObserver = (): void => {}
    releaseReuseDispatchTab = (): void => {}
  }
  const markCompletionResult = async (): Promise<void> => {
    if (completionMarked || settling) {
      return
    }
    settling = true
    const failure = pendingFailure
    try {
      await args.markDispatchResult({
        runId: args.run.id,
        status: failure ? 'dispatch_failed' : 'completed',
        workspaceId: args.worktree.id,
        workspaceDisplayName: args.worktree.displayName,
        outputSnapshot: getOutputSnapshot(),
        precheckResult: args.precheckResult,
        error: failure,
        ...providerSessionFields()
      })
    } catch (error) {
      settling = false
      throw error
    }
    completionMarked = true
    settling = false
    cleanupRunObservers()
    if (failure) {
      // Why: markDispatchResult lets the execution host retire startup failures using persisted ownership.
      args.releaseTerminalOwnership()
      return
    }
    if (args.finalizeTerminalOwnership()) {
      await clearRetiredRunTerminalIdentity()
    }
  }
  const clearRetiredRunTerminalIdentity = async (): Promise<void> => {
    // Why: the owned terminal was just retired, so the run's pane/pty
    // pointers now reference a closed tab. Drop them (best-effort) so
    // "View run" resolves to the workspace/snapshot instead of dead-ending
    // on an unavailable terminal.
    try {
      await args.markDispatchResult({
        runId: args.run.id,
        status: 'completed',
        terminalSessionId: null,
        terminalPaneKey: null,
        terminalPtyId: null
      })
    } catch (error) {
      console.error('[automations] Failed to clear retired terminal identity:', error)
    }
  }
  const markExitResult = async (code: number): Promise<void> => {
    if (completionMarked || settling) {
      return
    }
    pendingFailure =
      pendingFailure ?? (code === 0 ? null : `Automation process exited with code ${code}.`)
    await markCompletionResult()
  }
  const settleLateResult = (result: Promise<void>): void => {
    // Why: status/exit callbacks have no awaitable caller; the result
    // path retains ownership until its result is durably recorded.
    void result.catch((error) => {
      console.error('[automations] Failed to persist late automation result:', error)
    })
  }
  const handleAgentDone = (
    entry?: Pick<AgentStatusEntry, 'failed' | 'failureReason' | 'interrupted' | 'sessionBoundary'>
  ): void => {
    if (entry?.sessionBoundary || completionMarked || settling) {
      return
    }
    pendingFailure = entry?.failed
      ? (entry.failureReason ?? 'The agent stopped without finishing.')
      : entry?.interrupted
        ? 'The automation was cancelled.'
        : null
    if (completionMarked) {
      return
    }
    if (!dispatchMarked) {
      pendingDone = true
      return
    }
    settleLateResult(markCompletionResult())
  }
  const handleExit = (code: number): void => {
    if (completionMarked) {
      return
    }
    if (!dispatchMarked) {
      pendingExitCode = code
      return
    }
    settleLateResult(markExitResult(code))
  }
  const observeAgentStatus = (
    targetPaneKey: string,
    startedAfter: number,
    options?: { requireWorkingAfterStart?: boolean }
  ): void => {
    let sawWorkingAfterStart = false
    let observedStateHistory: AgentStateHistoryEntry[] = []
    let observedEntry: AgentStatusEntry | undefined
    const checkCurrentStatus = (): void => {
      const entryChange = selectAutomationAgentStatusEntryChange(
        useAppStore.getState().agentStatusByPaneKey,
        targetPaneKey,
        observedEntry
      )
      if (entryChange === UNCHANGED_AUTOMATION_AGENT_STATUS_ENTRY) {
        return
      }
      const entry = entryChange
      observedEntry = entry
      if (!entry || entry.updatedAt < startedAfter) {
        return
      }
      noteProviderSession(entry)
      const historyOverlap = getAgentStateHistoryOverlap(observedStateHistory, entry.stateHistory)
      // Why: sawWorkingAfterStart stays monotonic — a recreated entry
      // (transport loss, PTY exit, cap eviction) arrives with an empty
      // stateHistory, so clearing it here would strand reuseSession runs
      // with nothing left to re-derive the working edge from.
      for (const historicalState of entry.stateHistory.slice(historyOverlap)) {
        if (historicalState.startedAt < startedAfter) {
          continue
        }
        if (historicalState.state === 'working') {
          sawWorkingAfterStart = true
        }
        if (
          historicalState.state === 'done' &&
          !historicalState.sessionBoundary &&
          (!options?.requireWorkingAfterStart || sawWorkingAfterStart)
        ) {
          // Why: this `done` already rolled out of the live entry, so its output
          // survives only in the entry-level completed slot.
          latestAssistantMessage =
            entry.lastCompletedAssistantMessage?.trim() || latestAssistantMessage
          handleAgentDone(historicalState)
          return
        }
      }
      observedStateHistory = [...entry.stateHistory]
      if (entry.state === 'working') {
        sawWorkingAfterStart = true
      }
      if (
        entry.state === 'done' &&
        // Why: a session-boundary done is the agent CONNECTING (Claude SessionStart
        // fires at launch, before the argv prompt submits) — completing here would
        // close the tab and record an empty run result.
        entry.sessionBoundary !== true &&
        (!options?.requireWorkingAfterStart || sawWorkingAfterStart)
      ) {
        latestAssistantMessage = entry.lastAssistantMessage?.trim() || latestAssistantMessage
        handleAgentDone(entry)
      }
    }
    // Why: Codex/Claude completion normally arrives through the global
    // hook IPC listener, not the hidden PTY OSC fallback.
    unsubscribeAgentStatus = useAppStore.subscribe(checkCurrentStatus)
    checkCurrentStatus()
  }

  return {
    appendOutput: (chunk: string) => outputSnapshotBuffer.append(chunk),
    captureAssistantMessage: (message: string | null | undefined) => {
      latestAssistantMessage = message?.trim() || latestAssistantMessage
    },
    cleanupRunObservers,
    handleAgentDone,
    handleExit,
    observeAgentStatus,
    setReuseDispatchTabRelease: (release: () => void) => {
      releaseReuseDispatchTab = release
    },
    setSessionObserver: (unsubscribe: () => void) => {
      unsubscribeSessionObserver = unsubscribe
    },
    setThreadResume: (resume: AutomationRunResume | null) => {
      threadResume = resume
    },
    providerSessionFields,
    settlePendingAfterDispatch: async () => {
      dispatchMarked = true
      if (pendingDone) {
        await markCompletionResult()
      } else if (pendingExitCode !== null) {
        await markExitResult(pendingExitCode)
      }
    }
  }
}

function agentStateHistoryEntriesEqual(
  left: AgentStateHistoryEntry,
  right: AgentStateHistoryEntry
): boolean {
  return (
    left.state === right.state &&
    left.prompt === right.prompt &&
    left.startedAt === right.startedAt &&
    left.interrupted === right.interrupted &&
    left.failed === right.failed &&
    left.failureReason === right.failureReason &&
    left.sessionBoundary === right.sessionBoundary
  )
}

function getAgentStateHistoryOverlap(
  previous: AgentStateHistoryEntry[],
  current: AgentStateHistoryEntry[]
): number {
  for (let overlap = Math.min(previous.length, current.length); overlap > 0; overlap -= 1) {
    const previousOffset = previous.length - overlap
    if (
      current
        .slice(0, overlap)
        .every((entry, index) =>
          agentStateHistoryEntriesEqual(entry, previous[previousOffset + index])
        )
    ) {
      return overlap
    }
  }
  return 0
}
