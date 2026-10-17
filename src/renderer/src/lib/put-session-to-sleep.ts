import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { markManualSessionSleepExit, unmarkManualSessionSleepExit } from './manual-session-sleep'
import {
  planCurrentSessionSleep,
  sessionSleepRefusalMessage,
  type SessionSleepPlan
} from './session-sleep-target'
import type { SidebarSession } from './sidebar-sessions'

export type SessionSleepResult = { ok: boolean; message?: string }

type SleepableRow = Pick<SidebarSession, 'kind' | 'worktreeId' | 'tabId' | 'paneKey'>

type PutSessionToSleepDeps = {
  plan: (session: SleepableRow) => SessionSleepPlan
  shutdownPane: ReturnType<typeof useAppStore.getState>['shutdownCompletedAgentPaneForHibernation']
}

function defaultDeps(): PutSessionToSleepDeps {
  return {
    plan: planCurrentSessionSleep,
    shutdownPane: (worktreeId, opts) =>
      useAppStore.getState().shutdownCompletedAgentPaneForHibernation(worktreeId, opts)
  }
}

function sleepFailureMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error)
  if (code === 'agent_hibernation_capture_missing') {
    return sessionSleepRefusalMessage('not-resumable')
  }
  if (code === 'agent_hibernation_automatic_resume_blocked') {
    return sessionSleepRefusalMessage('resume-blocked')
  }
  return translate('conversations.sleep.failed', 'Could not put this session to sleep: {{error}}', {
    error: code
  })
}

/**
 * Kill one conversation's agent PTY and leave the durable resume record the pane wakes from.
 * Reuses the pane-level hibernation shutdown, which stores the record before the kill and refuses
 * (leaving the agent running) when no resumable identity can be captured.
 */
export async function putSidebarSessionToSleep(
  session: SleepableRow,
  deps: PutSessionToSleepDeps = defaultDeps()
): Promise<SessionSleepResult> {
  const plan = deps.plan(session)
  if (!plan.ok) {
    return { ok: false, message: sessionSleepRefusalMessage(plan.reason) }
  }
  const { worktreeId, ...pane } = plan.target
  markManualSessionSleepExit(pane.ptyId)
  try {
    await deps.shutdownPane(worktreeId, { ...pane, captureMode: 'manual-session-sleep' })
    return { ok: true }
  } catch (error) {
    unmarkManualSessionSleepExit(pane.ptyId)
    return { ok: false, message: sleepFailureMessage(error) }
  }
}
