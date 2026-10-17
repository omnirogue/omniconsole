import type { AgentProviderSessionMetadata } from './agent-session-resume'
import type { AutomationRun } from './automations-types'
import type {
  AutomationRunProviderSession,
  AutomationRunResume
} from './automation-run-resume-types'
import {
  isAutomationRunProviderSessionAgent,
  readAutomationRunProviderSession
} from './automation-run-provider-session'
import { normalizeRuntimePathForComparison } from './cross-platform-path'
import { parsePaneKey } from './stable-pane-id'
import type { TuiAgent } from './tui-agent'

/**
 * Whether a routine dispatch whose pane is gone should resume the routine's own
 * provider thread. Sits behind findReusableAutomationSession: a live pane always
 * wins, this only decides between "resume the recorded thread" and "start fresh".
 */
export type AutomationThreadResumeDecision =
  | {
      kind: 'resume'
      /** Run whose thread is resumed; its transcript path lets main verify provenance. */
      sourceRunId: string
      providerSession: AgentProviderSessionMetadata
      recorded: AutomationRunProviderSession
    }
  /** A thread was recorded but must not be resumed; `reason` lands on the run. */
  | { kind: 'fresh'; requested: string; reason: string }

/** Provider thread ids open in panes whose PTY is still live, across every workspace. */
export function collectOpenProviderThreadIds(state: {
  agentStatusByPaneKey?: Record<
    string,
    { providerSession?: AgentProviderSessionMetadata | null } | null | undefined
  >
  ptyIdsByTabId?: Record<string, readonly string[] | undefined>
}): Set<string> {
  const open = new Set<string>()
  for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey ?? {})) {
    const parsed = parsePaneKey(paneKey)
    if (
      entry?.providerSession?.key === 'session_id' &&
      parsed &&
      (state.ptyIdsByTabId?.[parsed.tabId]?.length ?? 0) > 0
    ) {
      open.add(entry.providerSession.id)
    }
  }
  return open
}

function homesEqual(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}

export function decideAutomationThreadResume(args: {
  automationId: string
  agentId: TuiAgent
  worktreeId: string
  currentRunId: string
  runs: readonly AutomationRun[]
  /** Account home the launch will run under, when the caller pins one. A recorded
   *  thread in another home is never resumed: its rollout is not there. */
  expectedHome?: string | null
  /** False for SSH/runtime workspaces: thread provenance is only verifiable locally. */
  localWorkspace?: boolean
  /** Provider thread ids a live pane (any workspace) currently has open. Codex refuses to
   *  resume such a thread — "This conversation is open in another app · R to Retry" — and
   *  measured 2026-09-20 the refused pane was still recorded as a completed run. */
  openThreadIds?: ReadonlySet<string>
}): AutomationThreadResumeDecision | null {
  if (!isAutomationRunProviderSessionAgent(args.agentId)) {
    return null
  }
  const newest = args.runs
    .filter(
      (run) =>
        run.id !== args.currentRunId &&
        run.automationId === args.automationId &&
        run.workspaceId === args.worktreeId &&
        run.status === 'completed' &&
        readAutomationRunProviderSession(run, args.agentId) !== null
    )
    .sort((left, right) => right.createdAt - left.createdAt)[0]
  if (!newest) {
    return null
  }
  const recorded = readAutomationRunProviderSession(newest, args.agentId)!
  if (args.localWorkspace === false) {
    return {
      kind: 'fresh',
      requested: recorded.providerSessionId,
      reason: 'Thread resume is only verifiable for local workspaces.'
    }
  }
  if (args.openThreadIds?.has(recorded.providerSessionId)) {
    return {
      kind: 'fresh',
      requested: recorded.providerSessionId,
      // Why two reasons: Codex refuses a thread open elsewhere. Claude would take the
      // prompt in that pane instead (findReusableAutomationSession, headless-dispatch), so
      // reaching here means the pane is busy or a person took it over.
      reason:
        args.agentId === 'codex'
          ? 'The recorded thread is still open in another pane; Codex would refuse to resume it.'
          : 'The recorded thread is open in a pane that is busy or taken over; the routine starts its own session.'
    }
  }
  if (
    args.expectedHome &&
    recorded.providerSessionHome &&
    !homesEqual(args.expectedHome, recorded.providerSessionHome)
  ) {
    return {
      kind: 'fresh',
      requested: recorded.providerSessionId,
      reason: 'The recorded thread belongs to a different account home.'
    }
  }
  return {
    kind: 'resume',
    sourceRunId: newest.id,
    recorded,
    providerSession: {
      key: 'session_id',
      id: recorded.providerSessionId,
      ...(recorded.providerSessionTranscriptPath
        ? { transcriptPath: recorded.providerSessionTranscriptPath }
        : {})
    }
  }
}

/**
 * What the hook proved about a resume request once the pane named its thread: the
 * requested id means the thread was resumed; any other id means the provider (or
 * main's provenance check) started a fresh one.
 */
export function confirmAutomationThreadResume(
  resume: AutomationRunResume,
  observed: Pick<AgentProviderSessionMetadata, 'id'> | null | undefined
): AutomationRunResume {
  if (resume.outcome !== 'resumed' || !observed) {
    return resume
  }
  return observed.id === resume.requested
    ? resume
    : {
        ...resume,
        outcome: 'fresh',
        reason: `The agent opened thread ${observed.id} instead of the requested one.`
      }
}
