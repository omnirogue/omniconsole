import { useCallback, useEffect, useId, useRef, type RefObject } from 'react'
import { conversationViewKey } from '@/lib/conversation-view'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import type { SessionChain } from '../../../../shared/session-chain-types'
import {
  workHeaderDefaultCollapsed,
  workHeaderNeedsYouKey,
  workHeaderQueuedCount
} from './work-header-summary'

/** Anything in the panel that holds unsaved words: an open editor, a draft row, a field. */
const EDITING_SURFACE_SELECTOR =
  '[data-next-action-outcome-editor], [data-up-next-block][data-state="draft"], textarea, input, [role="combobox"]'

/** The last needs-you key each conversation auto-expanded for; a fold stays until a new one. */
const lastAutoExpandedKey = new Map<string, string>()

/** Tests only: forget which asks already opened a header. */
export function forgetWorkHeaderAutoExpands(): void {
  lastAutoExpandedKey.clear()
}

type ChainSnapshot = {
  chainId: string | null
  outcomeSet: boolean
  outcomeTitle: string | null
  outcomeRevision: number | null
  queued: number
}

function snapshot(chain: SessionChain | null): ChainSnapshot {
  const outcome = chain?.outcomeSet?.outcomes[0]
  return {
    chainId: chain?.id ?? null,
    outcomeSet: Boolean(chain?.outcomeSet),
    outcomeTitle: outcome?.title ?? null,
    outcomeRevision: chain?.outcomeSet?.revision ?? null,
    queued: workHeaderQueuedCount(chain)
  }
}

/** T1: an outcome was just chosen, or its saved words changed. T2: more steps were queued. */
function foldsOnTransition(previous: ChainSnapshot, next: ChainSnapshot): boolean {
  const chosen = !previous.outcomeSet && next.outcomeSet
  const edited =
    previous.outcomeSet &&
    next.outcomeSet &&
    previous.chainId === next.chainId &&
    (previous.outcomeTitle !== next.outcomeTitle ||
      previous.outcomeRevision !== next.outcomeRevision)
  const queued = next.queued > previous.queued
  return chosen || edited || queued
}

function isTextField(element: Element | null): boolean {
  if (!element) {
    return false
  }
  if (element instanceof HTMLTextAreaElement) {
    return true
  }
  if (element instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'file'].includes(
      element.type
    )
  }
  return (element as HTMLElement).isContentEditable === true
}

/** g1 + g2: the panel holds an editing surface, or the person is typing inside it. */
function panelIsBeingEdited(panel: HTMLElement): boolean {
  const editing = [...panel.querySelectorAll(EDITING_SURFACE_SELECTOR)].some((element) => {
    // Context search is always present. Only its draft text or focus should hold the panel open.
    if (
      element.closest('[data-session-context-editor]') &&
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
    ) {
      return Boolean(element.value.trim())
    }
    return true
  })
  if (editing) {
    return true
  }
  const active = panel.ownerDocument.activeElement
  return Boolean(active && panel.contains(active) && isTextField(active))
}

/**
 * Whether folding would strand the focus: it sits on a control the fold unmounts, or nowhere.
 * Focus that is elsewhere (the terminal, the Prompt box) is left alone — a chain that merely
 * loads after the header mounted must never pull the caret out of what the person is typing.
 */
function focusWouldBeLost(panel: HTMLElement): boolean {
  const active = panel.ownerDocument.activeElement
  return !active || active === panel.ownerDocument.body || panel.contains(active)
}

/**
 * Keyboard loop (brief 78 #8): Escape pressed on a control INSIDE the open panel — a row, a
 * chip, a button — folds it. Not from a text field (Escape there is the field's own: it closes
 * a picker or drops an edit), not from anything portaled out of the panel (an open Select or
 * popover lives at the body and closes itself on the same key), and not once something else
 * has already answered the key.
 */
export function escapeFoldsPanel(
  event: { key: string; defaultPrevented: boolean; target: EventTarget | null },
  panel: HTMLElement | null
): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented || !panel) {
    return false
  }
  const target = event.target instanceof Element ? event.target : null
  return Boolean(target && panel.contains(target) && !isTextField(target))
}

export type WorkHeaderCollapse = {
  collapsed: boolean
  panelId: string
  setCollapsed: (collapsed: boolean) => void
  toggle: () => void
  /** Escape inside the open panel, off a text field: fold and put focus on the chevron. */
  onPanelKeyDown: (event: {
    key: string
    defaultPrevented: boolean
    target: EventTarget | null
    preventDefault: () => void
    stopPropagation: () => void
  }) => void
}

/**
 * The fold of one conversation's Outcome / Up next header: the person's saved choice, else
 * folded by default. Auto-folds when an outcome is committed or steps
 * are queued (never over an editor, a draft, a focused field, or an open ask), and opens once
 * for each new ask. Persisted per device under the same key the sidebar row uses.
 */
export function useWorkHeaderCollapse({
  session,
  chain,
  paneAgentState,
  panelRef,
  chevronRef
}: {
  session: SidebarSession
  chain: SessionChain | null
  paneAgentState: AgentStatusState | null | undefined
  panelRef: RefObject<HTMLElement | null>
  chevronRef: RefObject<HTMLButtonElement | null>
}): WorkHeaderCollapse {
  const key = conversationViewKey(session)
  const panelId = useId()
  const choice = useSessionSidebarView((state) => state.view.workHeaderCollapsed?.[key])
  // Why latched at mount: a live default would fold an open panel the moment a chain gained an
  // outcome, past every guard below. After mount only the transitions and the person fold it.
  const initial = useRef<boolean | null>(null)
  initial.current ??= workHeaderDefaultCollapsed()
  const collapsed = choice ?? initial.current
  const setCollapsed = useCallback(
    (next: boolean) => useSessionSidebarView.getState().setWorkHeaderCollapsed(key, next),
    [key]
  )
  const previous = useRef<{ key: string; chain: ChainSnapshot } | null>(null)
  const needsYouKey = workHeaderNeedsYouKey(chain, session, paneAgentState)

  useEffect(() => {
    const next = snapshot(chain)
    const before = previous.current
    previous.current = { key, chain: next }
    if (!before || before.key !== key) {
      // Why seed, not expand: an ask that was already open when this header mounted is not a
      // transition; tab switches and remounts must never open the panel by themselves.
      if (needsYouKey) {
        lastAutoExpandedKey.set(key, needsYouKey)
      }
      return
    }
    if (needsYouKey && lastAutoExpandedKey.get(key) !== needsYouKey) {
      lastAutoExpandedKey.set(key, needsYouKey)
      if (collapsed) {
        setCollapsed(false)
      }
      return
    }
    // Why `collapsed` is a dependency: a plain toggle re-runs this with an unchanged snapshot,
    // which is a no-op; the transitions above only ever fire on a chain or status change.
    if (!foldsOnTransition(before.chain, next)) {
      return
    }
    const panel = panelRef.current
    // Guards g3 (an open ask), g4 (already folded), g1 + g2 (an editing surface or typing).
    if (needsYouKey || collapsed || !panel || panelIsBeingEdited(panel)) {
      return
    }
    const rescueFocus = focusWouldBeLost(panel)
    setCollapsed(true)
    if (rescueFocus) {
      chevronRef.current?.focus()
    }
  }, [chain, key, needsYouKey, collapsed, panelRef, chevronRef, setCollapsed])

  return {
    collapsed,
    panelId,
    setCollapsed,
    toggle: () => setCollapsed(!collapsed),
    onPanelKeyDown: (event) => {
      if (!escapeFoldsPanel(event, panelRef.current)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      setCollapsed(true)
      chevronRef.current?.focus()
    }
  }
}
