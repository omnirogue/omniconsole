import { create } from 'zustand'
import { useAppStore } from '@/store'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import type {
  LaunchAgentInNewTabArgs,
  LaunchAgentInNewTabResult
} from '@/lib/launch-agent-in-new-tab-types'
import { getAgentDetectionTargetKeyForWorktree } from '@/hooks/useAgentDetectionTarget'
import { reservePaneConversationLaunch } from './pane-conversation-launch-reservation'
import { translate } from '@/i18n/i18n'

export const CONVERSATION_LAUNCH_VERIFICATION_TIMEOUT_MS = 20_000

export type ConversationLaunchDraft = {
  text: string
  status: 'checking' | 'launching' | 'failed'
  error?: string
}

export const useConversationLaunchDrafts = create<{
  drafts: Record<string, ConversationLaunchDraft>
}>(() => ({ drafts: {} }))

export function updateConversationLaunchDraft(
  tabId: string,
  patch: Partial<ConversationLaunchDraft>
): void {
  useConversationLaunchDrafts.setState((state) => {
    const draft = state.drafts[tabId]
    return draft ? { drafts: { ...state.drafts, [tabId]: { ...draft, ...patch } } } : state
  })
}

function forgetDraft(tabId: string): void {
  useConversationLaunchDrafts.setState((state) => {
    const drafts = { ...state.drafts }
    delete drafts[tabId]
    return { drafts }
  })
}

function launchFailedMessage(): string {
  return translate(
    'conversations.startFailed',
    'Work could not start. Check the connection and try again.'
  )
}

/** Reserve visible UI before discovery; only the verified continuation may replace it. */
export function reserveConversationLaunch(
  input: {
    worktreeId: string
    groupId?: string
    verify: () => Promise<
      Pick<
        LaunchAgentInNewTabArgs,
        | 'agent'
        | 'launchPreferences'
        | 'launchEnv'
        | 'conversationLauncher'
        | 'prompt'
        | 'promptDelivery'
        | 'onSessionCreated'
        | 'onPromptDelivered'
      >
    >
    navigate?: boolean
    submissionId?: string
    onLaunchResult?: (result: LaunchAgentInNewTabResult) => void
    onError?: (error: unknown, invoked: boolean) => void
    onSettled?: () => void
    /** Once the verified launch has started (never on a failed or abandoned one). */
    onStarted?: () => void
    scopeIsCurrent: () => boolean
    viewModePreference: 'chat' | 'terminal'
  } & Pick<LaunchAgentInNewTabArgs, 'outcome' | 'hubTaskId'>
): string {
  if (input.navigate === false) {
    return reservePaneConversationLaunch(input)
  }
  const state = useAppStore.getState()
  const owner = getAgentDetectionTargetKeyForWorktree(state, input.worktreeId)
  const path = state.getKnownWorktreeById(input.worktreeId)?.path
  const tabId = createBrowserUuid()
  useConversationLaunchDrafts.setState((draftState) => ({
    drafts: { ...draftState.drafts, [tabId]: { text: '', status: 'checking' } }
  }))
  const tab = state.createTab(input.worktreeId, input.groupId, undefined, {
    id: tabId,
    conversationLaunchPending: true
  })
  state.setTabCustomTitle(tab.id, translate('conversations.newConversation', 'New conversation'), {
    origin: 'generated'
  })
  state.setActiveTabType('terminal')
  state.setActiveView('terminal')
  const groupId = useAppStore
    .getState()
    .unifiedTabsByWorktree[input.worktreeId]?.find((entry) => entry.entityId === tab.id)?.groupId
  const stillReserved = (): boolean =>
    useAppStore
      .getState()
      .tabsByWorktree[input.worktreeId]?.some(
        (entry) => entry.id === tab.id && entry.conversationLaunchPending
      ) === true
  const unsubscribe = useAppStore.subscribe(() => {
    if (!stillReserved()) {
      unsubscribe()
      forgetDraft(tab.id)
    }
  })
  void (async () => {
    try {
      const verified = await verifyConversationLaunch(input.verify)
      if (!stillReserved()) {
        return
      }
      const current = useAppStore.getState()
      if (
        !owner ||
        owner !== getAgentDetectionTargetKeyForWorktree(current, input.worktreeId) ||
        !path ||
        path !== current.getKnownWorktreeById(input.worktreeId)?.path ||
        !input.scopeIsCurrent() ||
        !current.groupsByWorktree[input.worktreeId]?.some((group) => group.id === groupId)
      ) {
        throw new Error(
          translate(
            'conversations.launchLocationChanged',
            'This conversation’s work location or account changed. Close it and start a new conversation.'
          )
        )
      }
      const text = useConversationLaunchDrafts.getState().drafts[tab.id]?.text ?? ''
      updateConversationLaunchDraft(tab.id, { status: 'launching' })
      const launched = launchAgentInNewTab({
        ...verified,
        worktreeId: input.worktreeId,
        groupId,
        tabId: tab.id,
        reservedConversationTabId: tab.id,
        launchSource: 'sidebar',
        viewModePreference: input.viewModePreference,
        ...(input.outcome ? { outcome: input.outcome } : {}),
        ...(input.hubTaskId ? { hubTaskId: input.hubTaskId } : {}),
        // Why: an outcome or task launch submits, so typed text joins it instead of staying a draft.
        ...(text.trim()
          ? {
              prompt: [verified.prompt, text].filter(Boolean).join('\n\n'),
              promptDelivery:
                verified.promptDelivery ??
                (input.outcome || input.hubTaskId ? 'auto-submit' : 'draft')
            }
          : {})
      })
      if (!launched) {
        throw new Error(launchFailedMessage())
      }
      if (launched.tabId !== null) {
        // Why not awaited: the reservation settles now, as before; only `onStarted` waits.
        void Promise.resolve(launched.launchCompletion ?? true).then(
          (ok) => {
            if (ok) {
              input.onStarted?.()
            }
          },
          () => undefined
        )
        return
      }
      const completion =
        launched.launchCompletion ??
        launched.promptDeliveryResult?.then((result) => result.delivered)
      if (!completion || !(await completion)) {
        throw new Error(launchFailedMessage())
      }
      input.onStarted?.()
      if (stillReserved()) {
        useAppStore.getState().closeTab(tab.id, { reason: 'cleanup', captureRecentlyClosed: false })
      }
    } catch (error) {
      if (stillReserved()) {
        updateConversationLaunchDraft(tab.id, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error)
        })
      }
    } finally {
      input.onSettled?.()
    }
  })()
  return tab.id
}

export async function verifyConversationLaunch<T>(
  verify: () => Promise<T>,
  timeoutMessage?: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      verify(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                timeoutMessage ??
                  translate(
                    'conversations.verificationTimedOut',
                    'Agent availability could not be verified in time. Your request is still here; close this conversation and try again.'
                  )
              )
            ),
          CONVERSATION_LAUNCH_VERIFICATION_TIMEOUT_MS
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
