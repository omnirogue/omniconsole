import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { AutomationRun, AutomationRunOutputSnapshot } from '../../shared/automations-types'
import type { AutomationRunCompletionObservation } from './run-completion-watcher'
import type { AutomationPaneCloseHost } from './failed-pane-cleanup'

export type AutomationRunHookEvidence = {
  state: string
  agentType?: string
  providerSession?: { key: string; id: string }
  stateStartedAt?: number
  updatedAt?: number
  observation?: AgentStatusIpcPayload['observation']
  providerSessionOnly?: boolean
  onAttachedPty?: boolean
  failed?: boolean
  failureReason?: string
  interrupted?: boolean
  sessionBoundary?: boolean
}

/** Freeze primitives: store and hook rows can be updated in place during an await. */
function runIdentity(run: AutomationRun | null): string {
  return JSON.stringify(
    run && [
      run.id,
      run.automationId,
      run.status,
      run.dispatchedAt,
      run.terminalPaneKey,
      run.terminalPtyId,
      run.terminalProcessIncarnation,
      run.providerSessionId,
      run.providerSessionAgent
    ]
  )
}

function hookIdentity(hook: AutomationRunHookEvidence | null): string {
  return JSON.stringify(
    hook && [
      hook.state,
      hook.agentType,
      hook.providerSession?.key,
      hook.providerSession?.id,
      hook.stateStartedAt,
      hook.updatedAt,
      hook.onAttachedPty,
      hook.providerSessionOnly,
      hook.sessionBoundary,
      hook.failed,
      hook.failureReason,
      hook.interrupted,
      hook.observation?.origin,
      hook.observation?.kind,
      hook.observation?.boundary,
      hook.observation?.authorityId,
      hook.observation?.incarnation,
      hook.observation?.revision,
      hook.observation?.observedAt
    ]
  )
}

function isCurrentTurnEnd(run: AutomationRun, hook: AutomationRunHookEvidence): boolean {
  const now = Date.now()
  const start = hook.stateStartedAt
  const update = hook.updatedAt
  return Boolean(
    (run.status === 'dispatched' || run.status === 'dispatching') &&
    run.terminalPaneKey &&
    run.terminalPtyId &&
    run.providerSessionId &&
    run.providerSessionAgent &&
    run.terminalProcessIncarnation &&
    typeof run.dispatchedAt === 'number' &&
    Number.isFinite(run.dispatchedAt) &&
    hook.state === 'done' &&
    hook.observation?.origin === 'hook' &&
    hook.observation.kind === 'transition' &&
    !hook.observation.boundary &&
    !hook.sessionBoundary &&
    hook.providerSessionOnly !== true &&
    hook.onAttachedPty === true &&
    hook.agentType === run.providerSessionAgent &&
    hook.providerSession?.key === 'session_id' &&
    hook.providerSession?.id === run.providerSessionId &&
    typeof start === 'number' &&
    Number.isFinite(start) &&
    start >= run.dispatchedAt &&
    typeof update === 'number' &&
    Number.isFinite(update) &&
    update >= start &&
    update <= now &&
    start <= now
  )
}

/** Bind every terminal result to the retained run, including legacy providers.
 * Provider provenance is needed only for recovering a missed working edge. */
export async function readBoundAutomationRunObservation(args: {
  runtime: AutomationPaneCloseHost & {
    getTerminalProcessIncarnation?(handle: string): string | null
  }
  handle: string
  readCurrentRun?: () => AutomationRun | null
  unchangedEvidence?: () => boolean
  readObservation: () => Promise<AutomationRunCompletionObservation | null>
}): Promise<AutomationRunCompletionObservation | null> {
  const { runtime, handle, readCurrentRun } = args
  if (!readCurrentRun) {
    return args.readObservation()
  }
  const run = readCurrentRun()
  if (
    !run ||
    !runtime.showTerminal ||
    !run.terminalPaneKey ||
    !run.terminalPtyId ||
    (run.status !== 'dispatched' && run.status !== 'dispatching')
  ) {
    return null
  }
  const expectedRun = runIdentity(run)
  const paneKey = run.terminalPaneKey
  const ptyId = run.terminalPtyId
  const unchanged = (): boolean => {
    try {
      return (
        runIdentity(readCurrentRun()) === expectedRun &&
        runtime.getTerminalHandleForPaneKey(paneKey) === handle &&
        (!run.terminalProcessIncarnation ||
          runtime.getTerminalProcessIncarnation?.(handle) === run.terminalProcessIncarnation) &&
        (args.unchangedEvidence?.() ?? true)
      )
    } catch {
      return false
    }
  }
  if (!unchanged()) {
    return null
  }
  try {
    const terminal = await runtime.showTerminal(handle)
    if (terminal.ptyId !== ptyId || !unchanged()) {
      return null
    }
    const observation = await args.readObservation()
    const currentTerminal = await runtime.showTerminal(handle)
    if (currentTerminal.ptyId !== ptyId || !unchanged()) {
      return null
    }
    return observation
  } catch {
    // Unknown transport/contact is not evidence that this dispatched turn died.
    return null
  }
}

/** A current native Stop can survive main restart without another working edge.
 * A restored done, identity refresh, title or old provider turn cannot prove it. */
export async function readCurrentAutomationRunTurnEnd(args: {
  runtime: AutomationPaneCloseHost & {
    getFreshAgentHookStatusForHandle?(handle: string): AutomationRunHookEvidence | null
    getTerminalProcessIncarnation?(handle: string): string | null
  }
  handle: string
  readCurrentRun?: () => AutomationRun | null
  readSnapshot: () => Promise<AutomationRunOutputSnapshot | null>
}): Promise<AutomationRunCompletionObservation | null> {
  const { runtime, handle, readCurrentRun } = args
  const run = readCurrentRun?.()
  const hook = runtime.getFreshAgentHookStatusForHandle?.(handle)
  if (!run || !hook || !isCurrentTurnEnd(run, hook)) {
    return null
  }
  const expectedHook = hookIdentity(hook)
  const failed = hook.failed || hook.interrupted
  const error =
    hook.failureReason ??
    (hook.interrupted ? 'The automation was cancelled.' : 'The agent stopped without finishing.')
  return readBoundAutomationRunObservation({
    runtime,
    handle,
    readCurrentRun,
    unchangedEvidence: () =>
      hookIdentity(runtime.getFreshAgentHookStatusForHandle?.(handle) ?? null) === expectedHook,
    readObservation: async () => ({
      status: failed ? 'dispatch_failed' : 'completed',
      outputSnapshot: await args.readSnapshot(),
      error: failed ? error : null
    })
  })
}
