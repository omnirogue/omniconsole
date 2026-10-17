import { useCallback, useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { translate } from '@/i18n/i18n'
import type { ConversationFleetSidebarGroup } from '@/lib/conversation-fleet-sidebar'
import {
  buildSessionFocusLines,
  SESSION_FOCUS_NEEDS_YOU_KEY,
  sessionFocusNeedsYouCount,
  type SessionFocusLines
} from '@/lib/session-focus-lines'
import type { SessionSidebarTree, SessionSidebarTreeRow } from '@/lib/session-sidebar-tree'
import { isSessionGroupCollapsed, sessionSidebarLayout } from '@/lib/session-sidebar-view'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { sessionSidebarViewChoice } from '@/lib/session-sidebar-view-choice'
import { pendingSessionAsk } from '../../../../../shared/session-questions'
import { useSessionQuestionsInline } from '@/components/needs-you/use-session-question-rows'

/** `off` while searching or on the technical surface: the tree answers those, never the summary. */
export type SessionFocusMode = 'off' | 'focus' | 'full'

/** The opened Needs you list shows this many at a time, then "Show more". */
export const SESSION_FOCUS_NEEDS_YOU_PAGE = 5
/** A drill-in from a Focus line returns to Focus after this long without a touch on the list. */
export const SESSION_FOCUS_DRILL_IDLE_MS = 60_000

/**
 * A click into a Focus line opens the full tree for now, never for the device: this window's
 * memory only, so a restart, the View picker or an idle minute brings Focus back.
 */
export const useSessionFocusDrill = create<{ drilled: boolean }>(() => ({ drilled: false }))
// Why not store state: pointer moves stamp it, and nothing should re-render for that.
let lastDrillActivityAt = 0

export function endSessionFocusDrill(): void {
  useSessionFocusDrill.setState({ drilled: false })
}

export function noteSessionFocusActivity(): void {
  lastDrillActivityAt = Date.now()
}

export type SessionFocusView<G extends ConversationFleetSidebarGroup> = {
  mode: SessionFocusMode
  /** The full tree is a drill-in from a Focus line, not the device's saved choice. */
  drilled: boolean
  lines: SessionFocusLines | null
  needsYouOpen: boolean
  /** Opened Needs you questions answered in place as cards; their rows are left out of the list. */
  questionSessions: readonly SidebarSession[]
  /** How many more the opened Needs you holds back. */
  needsYouMore: number
  showMoreNeedsYou: () => void
  /** What the list draws: the full tree, or in focus only the opened Needs you rows. */
  listGroups: readonly (G | ConversationFleetSidebarGroup)[]
  toggleNeedsYou: () => void
  showFull: (groupKey?: string) => void
  showFocus: () => void
  /** Takes a group toggle the focus view owns; true when it did. */
  handleToggle: (key: string) => boolean
}

/** Pane keys among `rows` whose question Needs you can answer in place, joined for a stable select. */
function usePendingQuestionKeys(rows: readonly SessionSidebarTreeRow[]): ReadonlySet<string> {
  const inline = useSessionQuestionsInline()
  const joined = useAppStore((state) =>
    inline
      ? rows
          .flatMap(({ session: { paneKey } }) => {
            const status = paneKey ? state.agentStatusByPaneKey[paneKey] : undefined
            return paneKey && status && pendingSessionAsk(status) ? [paneKey] : []
          })
          .join('\n')
      : ''
  )
  return useMemo(() => new Set(joined ? joined.split('\n') : []), [joined])
}

export function useSessionFocusView<G extends ConversationFleetSidebarGroup>(input: {
  groups: readonly G[]
  listGroups: readonly G[]
  technical: boolean
  query: string
  now: number
  /** Its asks the groups leave out (hidden, archived, in a hidden folder) count in Needs you. */
  tree?: Pick<SessionSidebarTree, 'putAwayAsks'>
}): SessionFocusView<G> {
  const { groups, listGroups, technical, query, now } = input
  const putAwayAsks = input.tree?.putAwayAsks
  const layout = useSessionSidebarView((state) => sessionSidebarLayout(state.view))
  const flat = useSessionSidebarView((state) => sessionSidebarViewChoice(state.view) === 'flat')
  const drilled = useSessionFocusDrill((state) => state.drilled) && layout === 'focus'
  const [needsYouOpen, setNeedsYouOpen] = useState(false)
  const [needsYouShown, setNeedsYouShown] = useState(SESSION_FOCUS_NEEDS_YOU_PAGE)
  const mode: SessionFocusMode =
    flat || technical || query.trim() !== '' || groups.length === 0
      ? 'off'
      : drilled
        ? 'full'
        : layout
  const lines = useMemo(
    () => (mode === 'focus' ? buildSessionFocusLines(groups, now, putAwayAsks) : null),
    [mode, groups, now, putAwayAsks]
  )
  const open = needsYouOpen && lines?.needsYou != null
  const needsYou = open ? lines?.needsYou : null
  const shownRows = useMemo(
    () => needsYou?.rows.slice(0, needsYouShown) ?? [],
    [needsYou, needsYouShown]
  )
  const questionKeys = usePendingQuestionKeys(shownRows)
  const focusGroups = useMemo((): ConversationFleetSidebarGroup[] => {
    if (!needsYou) {
      return []
    }
    const fleetRows = needsYou.fleetRows.slice(0, Math.max(0, needsYouShown - shownRows.length))
    // Why: a question answered in place as a card is not listed again as a row.
    const rows = shownRows.filter((row) => !questionKeys.has(row.session.paneKey ?? ''))
    return [
      {
        key: SESSION_FOCUS_NEEDS_YOU_KEY,
        kind: 'attention',
        label: translate('auto.components.SessionSidebar.needsYouGroup', 'Needs you'),
        rows,
        collapsed: false,
        hidden: false,
        attentionCount: sessionFocusNeedsYouCount(needsYou),
        canReorder: false,
        canHide: false,
        fleetRows
      }
    ]
  }, [needsYou, needsYouShown, shownRows, questionKeys])
  const questionSessions = useMemo(
    () =>
      shownRows
        .filter((row) => questionKeys.has(row.session.paneKey ?? ''))
        .map((row) => row.session),
    [shownRows, questionKeys]
  )
  useEffect(() => {
    if (!drilled) {
      return
    }
    lastDrillActivityAt = Date.now()
    let timer: ReturnType<typeof setTimeout>
    const check = (): void => {
      const idle = Date.now() - lastDrillActivityAt
      if (idle >= SESSION_FOCUS_DRILL_IDLE_MS) {
        endSessionFocusDrill()
      } else {
        timer = setTimeout(check, SESSION_FOCUS_DRILL_IDLE_MS - idle)
      }
    }
    timer = setTimeout(check, SESSION_FOCUS_DRILL_IDLE_MS)
    return () => clearTimeout(timer)
  }, [drilled])
  const showFull = useCallback((groupKey?: string) => {
    const store = useSessionSidebarView.getState()
    useSessionFocusDrill.setState({ drilled: true })
    if (groupKey && isSessionGroupCollapsed(store.view, groupKey)) {
      store.toggleCollapsed(groupKey)
    }
  }, [])
  const closeNeedsYou = useCallback(() => {
    setNeedsYouOpen(false)
    setNeedsYouShown(SESSION_FOCUS_NEEDS_YOU_PAGE)
  }, [])
  const showFocus = useCallback(() => {
    closeNeedsYou()
    endSessionFocusDrill()
    const store = useSessionSidebarView.getState()
    if (sessionSidebarLayout(store.view) !== 'focus') {
      store.setLayout('focus')
    }
  }, [closeNeedsYou])
  const toggleNeedsYou = useCallback(() => {
    if (needsYouOpen) {
      closeNeedsYou()
    } else {
      setNeedsYouOpen(true)
    }
  }, [needsYouOpen, closeNeedsYou])
  const handleToggle = useCallback(
    (key: string) => {
      if (key !== SESSION_FOCUS_NEEDS_YOU_KEY) {
        return false
      }
      toggleNeedsYou()
      return true
    },
    [toggleNeedsYou]
  )
  const showMoreNeedsYou = useCallback(
    () => setNeedsYouShown((shown) => shown + SESSION_FOCUS_NEEDS_YOU_PAGE),
    []
  )
  return {
    mode,
    drilled,
    lines,
    needsYouOpen: open,
    questionSessions,
    needsYouMore: needsYou ? Math.max(0, sessionFocusNeedsYouCount(needsYou) - needsYouShown) : 0,
    showMoreNeedsYou,
    listGroups: mode === 'focus' ? focusGroups : listGroups,
    toggleNeedsYou,
    showFull,
    showFocus,
    handleToggle
  }
}
