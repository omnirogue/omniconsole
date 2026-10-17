import { useAppStore } from '@/store'
import { useSessionGrid } from '@/store/session-grid'
import {
  useReadyPaneDrafts,
  updateReadyPane,
  updateReadySubmission,
  finishReadySubmission,
  readySubmissionInFlight,
  loadReadyPaneDrafts
} from '@/store/ready-pane-drafts'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { buildPaneSessions } from '@/lib/sidebar-sessions'
import { sessionGridContentForSession } from '@/lib/session-grid-panes'
import {
  reserveConversationLaunch,
  verifyConversationLaunch
} from '@/lib/conversation-launch-draft'
import { launcherViewModePreference } from '../sidebar/session-folders/new-conversation/launch-context'
import { prepareReadyPaneLaunch } from './prepare-ready-pane-launch'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { ReadyDraft, ReadySubmission } from '@/store/ready-pane-drafts'

const observers = new Map<string, () => void>()
const reconciling = new Set<string>()
const observerKey = (scope: string, paneId: string) => JSON.stringify([scope, paneId])
function current(scope: string, paneId: string): ReadySubmission | undefined {
  return useReadyPaneDrafts.getState().documents[scope]?.panes[paneId]?.submission
}

export function findReadySubmissionSession(
  submission: ReadySubmission,
  sessions: readonly SidebarSession[]
): SidebarSession | undefined {
  if (!submission.hostId || !submission.worktreeId || !submission.tabId) {
    return undefined
  }
  return sessions.find(
    (session) =>
      session.hostId === submission.hostId &&
      session.worktreeId === submission.worktreeId &&
      session.tabId === submission.tabId &&
      !session.launchPending &&
      !session.unavailable
  )
}

export function reconcileReadyPane(scope: string, paneId: string): boolean {
  const key = observerKey(scope, paneId)
  if (reconciling.has(key) || scope !== selectConsoleAccountScope(useAppStore.getState())) {
    return false
  }
  reconciling.add(key)
  try {
    return reconcilePublishedSubmission(scope, paneId)
  } finally {
    reconciling.delete(key)
  }
}

function reconcilePublishedSubmission(scope: string, paneId: string): boolean {
  const submission = current(scope, paneId)
  if (!submission || !['starting', 'attached', 'uncertain'].includes(submission.status)) {
    return false
  }
  const session = findReadySubmissionSession(submission, buildPaneSessions(useAppStore.getState()))
  if (!session) {
    return false
  }
  if (!submission.timings.published) {
    updateReadySubmission(scope, paneId, submission.id, {
      timings: { ...submission.timings, published: Date.now() }
    })
  }
  if (useReadyPaneDrafts.getState().errors[scope]) {
    return false
  }
  const grid = useSessionGrid.getState()
  const pane = useReadyPaneDrafts.getState().documents[scope]?.panes[paneId]
  if (!grid.commandCenter || grid.writeBlocked || !grid.panes[paneId] || !pane) {
    return false
  }
  let bound = current(scope, paneId)!
  if (!bound.boundPaneId) {
    const shown = grid.layout.tracks.flat().includes(paneId)
    if (!shown && grid.layout.tracks.flat().length >= 8) {
      return false
    }
    const content = sessionGridContentForSession(session)
    if (shown) {
      grid.replacePane(paneId, content)
    } else {
      grid.addPane(content)
    }
    const boundPaneId = useSessionGrid.getState().focusedPaneId
    if (!boundPaneId) {
      return false
    }
    updateReadySubmission(scope, paneId, submission.id, {
      boundPaneId,
      sourceShown: shown,
      status: bound.delivered
        ? 'attached'
        : bound.status === 'uncertain'
          ? 'uncertain'
          : 'attached',
      timings: { ...bound.timings, attached: Date.now() }
    })
    bound = current(scope, paneId)!
  }
  // Publication binds the pane immediately; only a delivery receipt may clear its saved draft.
  if (!bound.delivered || !finishReadySubmission(scope, paneId, submission.id)) {
    return false
  }
  if (bound.sourceShown && pane.fresh === 'slot') {
    const restored = grid.restorePane(paneId)
    if (restored.status === 'added') {
      grid.movePane(paneId, { paneId: bound.boundPaneId!, zone: 'center' })
    }
  }
  observers.get(observerKey(scope, paneId))?.()
  return true
}

export function observeReadyPane(scope: string, paneId: string): void {
  const key = observerKey(scope, paneId)
  if (observers.has(key)) {
    return
  }
  const unsubscribe = useAppStore.subscribe(() => {
    reconcileReadyPane(scope, paneId)
  })
  const unsubscribeGrid = useSessionGrid.subscribe(() => {
    reconcileReadyPane(scope, paneId)
  })
  observers.set(key, () => {
    unsubscribe()
    unsubscribeGrid()
    observers.delete(key)
  })
  reconcileReadyPane(scope, paneId)
}

export function recoverReadyPaneLaunches(scope: string): void {
  loadReadyPaneDrafts(scope)
  for (const [paneId, pane] of Object.entries(
    useReadyPaneDrafts.getState().documents[scope].panes
  )) {
    if (pane.submission && ['starting', 'attached', 'uncertain'].includes(pane.submission.status)) {
      observeReadyPane(scope, paneId)
    }
  }
}

export async function sendReadyPane(
  scope: string,
  paneId: string,
  draft: ReadyDraft
): Promise<void> {
  const pane = useReadyPaneDrafts.getState().documents[scope]?.panes[paneId]
  if (!pane || !draft.text.trim() || readySubmissionInFlight(pane.submission)) {
    return
  }
  const id = createBrowserUuid()
  const submission: ReadySubmission = {
    id,
    provider: pane.provider,
    status: 'validating',
    timings: { submitted: Date.now() }
  }
  if (
    !updateReadyPane(scope, paneId, (value) => ({
      ...value,
      drafts: { ...value.drafts, [pane.provider]: draft },
      submission
    }))
  ) {
    return
  }
  const fail = (error: unknown, uncertain = false) => {
    uncertain ||= Boolean(current(scope, paneId)?.boundPaneId)
    updateReadySubmission(scope, paneId, id, {
      status: uncertain ? 'uncertain' : 'failed',
      error: error instanceof Error ? error.message : String(error)
    })
    if (uncertain) {
      observeReadyPane(scope, paneId)
    } else {
      observers.get(observerKey(scope, paneId))?.()
    }
  }
  const scopeIsCurrent = () =>
    scope === selectConsoleAccountScope(useAppStore.getState()) && current(scope, paneId)?.id === id
  try {
    const verified = await verifyConversationLaunch(() =>
      prepareReadyPaneLaunch({ scope, workspace: pane.workspace, provider: pane.provider, draft })
    )
    if (!scopeIsCurrent()) {
      throw new Error('The account changed. Nothing launched.')
    }
    if (
      !updateReadyPane(scope, paneId, (value) => ({
        ...value,
        workspace: verified.worktreeId,
        submission: {
          ...submission,
          status: 'starting',
          worktreeId: verified.worktreeId,
          hostId: verified.hostId,
          tabId: id,
          timings: { ...submission.timings, validated: Date.now() }
        }
      }))
    ) {
      return
    }
    observeReadyPane(scope, paneId)
    const delivered = () => {
      const active = current(scope, paneId)
      if (active?.id !== id) {
        return
      }
      updateReadySubmission(scope, paneId, id, {
        delivered: true,
        timings: { ...active.timings, delivered: Date.now() }
      })
      reconcileReadyPane(scope, paneId)
    }
    reserveConversationLaunch({
      navigate: false,
      submissionId: id,
      worktreeId: verified.worktreeId,
      scopeIsCurrent,
      viewModePreference: launcherViewModePreference(useAppStore.getState().settings),
      verify: async () => ({
        ...verified,
        conversationLauncher: true,
        prompt: draft.text,
        promptDelivery: 'submit-after-ready',
        onSessionCreated: (tabId) => {
          updateReadySubmission(scope, paneId, id, { tabId })
          reconcileReadyPane(scope, paneId)
        },
        onPromptDelivered: delivered
      }),
      onError: (error, invoked) => fail(error, invoked),
      onLaunchResult: (result) => {
        if (!result) {
          fail('The launch was refused. Nothing launched.')
          return
        }
        if (result.tabId) {
          updateReadySubmission(scope, paneId, id, { tabId: result.tabId })
        }
        if (result.launchOutcome) {
          void result.launchOutcome
            .then((outcome) => {
              if (outcome !== 'started' && current(scope, paneId)?.id === id) {
                fail('The execution host could not confirm the launch.', outcome === 'uncertain')
              }
            })
            .catch((error) => fail(error, true))
        }
        if (result.promptDeliveryResult) {
          void result.promptDeliveryResult
            .then((receipt) => {
              if (receipt.delivered) {
                delivered()
              } else if (
                current(scope, paneId)?.id === id &&
                current(scope, paneId)?.status !== 'failed'
              ) {
                fail(
                  'Prompt delivery could not be confirmed. Check the existing session before retrying.',
                  true
                )
              }
            })
            .catch((error) => fail(error, true))
        }
      }
    })
    setTimeout(() => {
      if (
        current(scope, paneId)?.id === id &&
        ['starting', 'attached'].includes(current(scope, paneId)?.status ?? '')
      ) {
        fail(
          'The launch is taking longer than expected. Looking for its session; your draft is kept.',
          true
        )
      }
    }, 30_000)
  } catch (error) {
    fail(error)
  }
}
