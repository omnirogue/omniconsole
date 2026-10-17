import { bindRoutineConversation } from './routine-conversation-binding'
import { routineConversationHost } from './routine-conversation-host'
import { routineConversationKey, useRoutineSessionCatalog } from './routine-session-catalog'
import { matchesRoutineConversation } from '@/lib/routine-backed-session'
import { useAppStore } from '@/store'
import { buildSidebarSessions, type SidebarSession } from '@/lib/sidebar-sessions'
import { activateSidebarSession } from '@/lib/activate-sidebar-session'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { seedNativeChatLaunchDraftForAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { nativeChatEnabledByPreference } from '../../../../../shared/native-chat-preference'
import { getAutomationRunRepoId } from '../../../../../shared/automation-run-identity'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import type { Automation, AutomationRun } from '../../../../../shared/automations-types'
import { getAutomationRunMessage } from '@/components/automations/automation-run-content'
import {
  getAutomationHostTargetKey,
  listAutomationRunsForTarget,
  type AutomationHostTarget
} from '@/components/automations/automation-host-client'
import { routineRunConversation } from './routine-run-conversation'
import { useRoutineConversations } from './routine-conversation-state'

const opening = new Map<string, Promise<void>>()

export function openRoutineConversation(
  automation: Automation,
  sourceTarget: AutomationHostTarget,
  isCurrent: () => boolean = () => true
): Promise<void> {
  const key = routineConversationKey(sourceTarget, automation.id)
  const pending = opening.get(key)
  if (pending) {
    return pending
  }
  const request = openRoutineConversationOnce(automation, sourceTarget, isCurrent).finally(() =>
    opening.delete(key)
  )
  opening.set(key, request)
  return request
}

async function openRoutineConversationOnce(
  automation: Automation,
  sourceTarget: AutomationHostTarget,
  isCurrent: () => boolean = () => true
): Promise<void> {
  const initial = useAppStore.getState()
  const navigationUnchanged = () => {
    const current = useAppStore.getState()
    return (
      isCurrent() &&
      current.activeView === initial.activeView &&
      current.activeWorktreeId === initial.activeWorktreeId &&
      current.activeTabId === initial.activeTabId
    )
  }
  const key = JSON.stringify([getAutomationHostTargetKey(sourceTarget), automation.id])
  const hostId = routineConversationHost(automation, sourceTarget)
  const bind = (tabId: string, paneKey: string | null, sessionKey?: string | null) =>
    bindRoutineConversation(automation, sourceTarget, { tabId, paneKey, sessionKey }, hostId)
  const open = async (session: SidebarSession) => {
    if (!navigationUnchanged()) {
      return
    }
    const result = await activateSidebarSession(session)
    if (!result) {
      throw new Error('This routine’s conversation is unavailable. Check its workspace connection.')
    }
    if (result.handled !== 'opened') {
      return
    }
    const restored =
      sessions().find(
        (item) =>
          item.rowKey === session.rowKey ||
          (session.sessionKey && item.sessionKey === session.sessionKey)
      ) ?? session
    if (restored.tabId) {
      await bind(restored.tabId, restored.paneKey, restored.sessionKey)
    }
  }
  const cached = useRoutineConversations.getState().byRoutine[key]
  const sessions = () =>
    buildSidebarSessions(useAppStore.getState()).filter((s) => s.hostId === hostId)
  const catalogOwner = useRoutineSessionCatalog
    .getState()
    .owners.find((owner) => routineConversationKey(owner.sourceTarget, owner.automation.id) === key)
  const recorded = catalogOwner ? catalogOwner.automation.conversation : automation.conversation
  const existing =
    sessions().find((session) => matchesRoutineConversation(session, recorded)) ??
    sessions().find((session) => matchesRoutineConversation(session, cached))
  if (!nativeChatEnabledByPreference(useAppStore.getState().settings)) {
    await useAppStore.getState().updateSettingsOrThrow({ experimentalNativeChat: true })
  }
  if (existing) {
    return open(existing)
  }
  const runs = await listAutomationRunsForTarget(sourceTarget, automation.id)
  if (!navigationUnchanged()) {
    return
  }
  const latest = [...runs]
    .sort((a, b) => b.createdAt - a.createdAt)
    .find((run) => run.terminalPaneKey || run.terminalSessionId || run.chatSessionId)
  const session = routineRunConversation(runs, sessions())
  if (session) {
    return open(session)
  }
  // A dispatched run with no observable session may still be executing on its host.
  if (runs.some((run) => ['pending', 'dispatching', 'dispatched'].includes(run.status))) {
    throw new Error(
      'This routine has a run in progress. Its conversation is not available yet; check the host connection.'
    )
  }
  const state = useAppStore.getState()
  const repo = state.repos.find(
    (r) => r.id === getAutomationRunRepoId(automation) && getRepoExecutionHostId(r) === hostId
  )
  const workspaceId =
    automation.workspaceId ??
    latest?.workspaceId ??
    (repo ? state.worktreesByRepo[repo.id]?.find((w) => w.isMainWorktree)?.id : undefined)
  if (
    !workspaceId ||
    activateAndRevealWorkspace(workspaceId, {
      executionHostId: hostId,
      providesInitialSurface: true
    }) === false
  ) {
    throw new Error('Connect this routine’s workspace to open its conversation.')
  }
  const previousTabs = new Set(sessions().map((s) => s.tabId))
  const prompt = `Discuss this routine: ${automation.name}\n\n${automation.prompt}\n\n${describeLastRecordedResult(latest)}Review the latest results and proposed next steps. Ask me before taking any action.`
  const result = launchAgentInNewTab({
    agent: automation.agentId,
    worktreeId: workspaceId,
    viewModePreference: 'chat',
    promptDelivery: 'draft',
    prompt,
    quickCommandLabel: automation.name
  })
  if (!result) {
    throw new Error('The routine conversation could not be opened.')
  }
  if (result.tabId) {
    await bind(result.tabId, null)
    return
  }
  if (result.promptDeliveryResult) {
    const publication = await result.promptDeliveryResult
    if (!publication.delivered) {
      throw new Error('The host could not open the routine conversation.')
    }
  }
  const published = await new Promise<SidebarSession[]>((resolve) => {
    const find = () =>
      sessions().filter((s) => s.worktreeId === workspaceId && !previousTabs.has(s.tabId))
    const ready = find()
    if (ready.length > 0) {
      resolve(ready)
      return
    }
    const timeout = setTimeout(() => {
      unsubscribe()
      resolve([])
    }, 15_000)
    const unsubscribe = useAppStore.subscribe(() => {
      const rows = find()
      if (rows.length > 0 || !isCurrent()) {
        clearTimeout(timeout)
        unsubscribe()
        resolve(rows)
      }
    })
  })
  if (published.length !== 1 || !published[0].tabId) {
    throw new Error(
      'The host has not published the routine conversation yet. Check its connection.'
    )
  }
  seedNativeChatLaunchDraftForAgentTab({
    tabId: published[0].tabId,
    agent: automation.agentId,
    text: prompt
  })
  await bind(published[0].tabId, published[0].paneKey, published[0].sessionKey)
}

/** The last result as prose: chrome-free, trimmed, with the actions block as a readable list. */
export function describeLastRecordedResult(latest: AutomationRun | null | undefined): string {
  if (!latest?.outputSnapshot?.content) {
    return ''
  }
  const message = getAutomationRunMessage(latest)
  const actions = message.actions.map(
    (action) => `- ${action.label}${action.reason ? ` — ${action.reason}` : ''}`
  )
  const proposed = actions.length ? `\n\nProposed actions:\n${actions.join('\n')}` : ''
  return `Last recorded result:\n${message.text}${proposed}\n\n`
}
