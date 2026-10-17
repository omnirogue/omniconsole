import { useCallback, useEffect, useMemo, useState } from 'react'
import { handoffApi } from '@/components/handoffs/handoff-client'
import { workflowData, workflowErrorMessage } from '@/lib/console-workflow-client'
import { findChainStepOutputForPane, useSessionFollowUpChains } from '@/lib/session-chain-registry'
import { pickSessionFollowUp } from '@/lib/session-follow-up-commands'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import {
  sessionChainStepOutputDir,
  type SessionChain
} from '../../../../shared/session-chain-types'
import type { TeamRosterPerson } from '../../../../shared/team-roster-search'
import type { FollowUpFormContext, FollowUpTask } from './session-follow-up-draft'
import { cardlessHandoffsEnabledByPreference } from '../../../../shared/cardless-handoff-preference'

export type FollowUpLoad<T> =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; value: T }
  | { phase: 'error'; message: string }

export type FollowUpTaskList = { tasks: FollowUpTask[]; truncated: boolean }

/** The follow-up saved on a session, kept current as the runner records progress. */
export function useSessionFollowUpFor(
  session: Pick<SidebarSession, 'worktreeId' | 'paneKey'> | null
): SessionChain | null {
  const chains = useSessionFollowUpChains()
  const worktreeId = session?.worktreeId ?? null
  const paneKey = session?.paneKey ?? null
  return useMemo(
    () => (worktreeId ? pickSessionFollowUp(chains, worktreeId, paneKey) : null),
    [chains, paneKey, worktreeId]
  )
}

function useLoad<T>(load: (() => Promise<T>) | null): {
  state: FollowUpLoad<T>
  reload: () => void
} {
  const [state, setState] = useState<FollowUpLoad<T>>({ phase: load ? 'loading' : 'idle' })
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!load) {
      setState({ phase: 'idle' })
      return
    }
    let live = true
    setState({ phase: 'loading' })
    load().then(
      (value) => live && setState({ phase: 'ready', value }),
      (error: unknown) => live && setState({ phase: 'error', message: workflowErrorMessage(error) })
    )
    return () => {
      live = false
    }
  }, [load, nonce])
  const reload = useCallback(() => setNonce((value) => value + 1), [])
  return { state, reload }
}

async function loadRoster(): Promise<TeamRosterPerson[]> {
  return workflowData(await handoffApi().recipients()).employees
}

async function loadMyTasks(): Promise<FollowUpTaskList> {
  const result = await window.api.backoffice.listTodo()
  if (!result.ok) {
    throw new Error(result.message)
  }
  const tasks = new Map<string, FollowUpTask>()
  for (const item of result.items) {
    if (!tasks.has(item.task_id)) {
      tasks.set(item.task_id, { id: item.task_id, title: item.title })
    }
  }
  return { tasks: [...tasks.values()], truncated: result.truncated }
}

/**
 * What the Next step form needs about a session: its workspace, the linked OmniOS
 * task (or the person's own tasks when none is linked), the active human roster and
 * the run manifest the session was told to write, when OmniConsole launched it.
 */
export function useSessionFollowUpContext(session: SidebarSession) {
  const worktree = useAppStore((state) => state.getKnownWorktreeById(session.worktreeId))
  // Why: `done` is the agent's end-of-turn report; the form only says the session stopped.
  const sessionStopped = useAppStore((state) =>
    session.paneKey ? state.agentStatusByPaneKey[session.paneKey]?.state === 'done' : false
  )
  const cardlessHandoffs = useAppStore((state) =>
    cardlessHandoffsEnabledByPreference(state.settings)
  )
  const workspacePath = worktree?.path ?? null
  const hubTaskId = worktree?.linkedWorkItem?.hubTaskId ?? null
  const linkedTitle = worktree?.linkedWorkItem?.title ?? null
  const paneKey = session.paneKey
  const context = useMemo<FollowUpFormContext | null>(() => {
    if (!workspacePath) {
      return null
    }
    const output = paneKey ? findChainStepOutputForPane(paneKey) : null
    return {
      workspacePath,
      // Why: the same path the chain prompt told the agent to write its manifest to.
      manifestPath: output
        ? `${sessionChainStepOutputDir(workspacePath, output.chainId, output.stepId)}/manifest.md`
        : null,
      linkedTask: hubTaskId ? { id: hubTaskId, title: linkedTitle ?? hubTaskId } : null,
      cardlessHandoffs
    }
  }, [cardlessHandoffs, hubTaskId, linkedTitle, paneKey, workspacePath])
  const roster = useLoad(loadRoster)
  const tasks = useLoad(context && !context.linkedTask ? loadMyTasks : null)
  return {
    context,
    roster: roster.state,
    reloadRoster: roster.reload,
    tasks: tasks.state,
    reloadTasks: tasks.reload,
    sessionStopped
  }
}
