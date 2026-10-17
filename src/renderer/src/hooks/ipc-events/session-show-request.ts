import { FOCUS_TERMINAL_PANE_EVENT, type FocusTerminalPaneDetail } from '@/constants/terminal'
import { FOCUSED_PANE_FLASH_MS } from '@/components/terminal-pane/focused-pane-rim-flash'
import { activateSidebarSession } from '@/lib/activate-sidebar-session'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { conversationViewKey } from '@/lib/conversation-view'
import {
  isTypingUnsentText,
  placeBesideInGrid,
  placeBesideInWorkspace
} from '@/lib/session-show-placement'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { activateStructuredAgentSessionTab } from '@/lib/structured-agent-session-tab-activation'
import type { SessionShowMode, SessionShowReply } from '../../../../shared/session-show'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { focusTerminalFromHost } from './terminal-ui-routing-ipc-bridge'

// Reuses the utility the sidebar's working dots pulse with; no new colour or motion.
const ROW_PULSE_CLASS = 'motion-safe:animate-pulse'
const FOCUS_HOLD_MS = 250

type Highlight = { flash: boolean; keepKeyboardFocus: boolean }

function leafOf(session: SidebarSession): string | null {
  return session.paneKey ? (parsePaneKey(session.paneKey)?.leafId ?? null) : null
}

/** Focuses (and lights) the target's pane where it now sits, in the workspace or the Grid. */
function highlightPane(session: SidebarSession, inGrid: boolean, options: Highlight): void {
  if (!session.tabId) {
    return
  }
  if (session.kind === 'structured') {
    if (!inGrid && !options.keepKeyboardFocus) {
      activateStructuredAgentSessionTab({ worktreeId: session.worktreeId, tabId: session.tabId })
    }
    return
  }
  const opts = {
    ...(options.flash ? { flashFocusedPane: true } : {}),
    ...(options.keepKeyboardFocus ? { keepKeyboardFocus: true } : {})
  }
  if (!inGrid) {
    activateTabAndFocusPane(session.tabId, leafOf(session), opts)
    return
  }
  const leafId = leafOf(session)
  if (!leafId) {
    return
  }
  const detail: FocusTerminalPaneDetail = { tabId: session.tabId, leafId, ...opts }
  // Why a frame: the Grid mounts the pane's terminal after the view switch renders.
  requestAnimationFrame(() =>
    window.dispatchEvent(new CustomEvent(FOCUS_TERMINAL_PANE_EVENT, { detail }))
  )
}

/** Scrolls the target's sidebar row into view and pulses it once, without focusing it. */
function pulseSidebarRow(session: SidebarSession): void {
  const key = conversationViewKey(session)
  // Why two frames: the row reveals (its folders open) after the screen change renders.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      // Why: keys carry colons and quotes; matching the attribute beats escaping it for a selector.
      const row = [...document.querySelectorAll<HTMLElement>('[data-session-key]')].find(
        (candidate) => candidate.dataset.sessionKey === key
      )
      if (!row) {
        return
      }
      row.scrollIntoView?.({ block: 'nearest' })
      row.classList.add(ROW_PULSE_CLASS)
      setTimeout(() => row.classList.remove(ROW_PULSE_CLASS), FOCUSED_PANE_FLASH_MS)
    })
  )
}

/** Puts keyboard focus back where the person was typing if a mounting pane took it. */
function holdKeyboardFocus(typing: HTMLElement): void {
  const restore = (): void => {
    if (typing.isConnected && document.activeElement !== typing) {
      typing.focus({ preventScroll: true })
    }
  }
  requestAnimationFrame(() => {
    restore()
    requestAnimationFrame(restore)
  })
  setTimeout(restore, FOCUS_HOLD_MS)
}

function replaceView(session: SidebarSession, options: Highlight): void {
  if (session.kind === 'terminal' && session.tabId) {
    // Why: the same path as `omni terminal focus`, plus the rim flash.
    focusTerminalFromHost({
      tabId: session.tabId,
      worktreeId: session.worktreeId,
      leafId: leafOf(session),
      ...(options.flash ? { flashFocusedPane: true } : {}),
      ...(options.keepKeyboardFocus ? { keepKeyboardFocus: true } : {})
    })
    return
  }
  void activateSidebarSession(session)
}

/**
 * `omni session show`: beside keeps what is on screen on the left and puts the target on the
 * right; replace shows it in place. Either way its pane rim flashes and its sidebar row pulses.
 */
export function showSidebarSession(
  session: SidebarSession,
  request: { mode: SessionShowMode; flash: boolean }
): SessionShowReply {
  const typing = document.activeElement
  const keepKeyboardFocus = isTypingUnsentText(typing)
  const options = { flash: request.flash, keepKeyboardFocus }
  let placement: SessionShowReply['placement'] = 'replaced'
  if (request.mode === 'replace') {
    replaceView(session, options)
  } else {
    const inWorkspace = placeBesideInWorkspace(session)
    placement = inWorkspace ?? placeBesideInGrid(session)
    highlightPane(session, inWorkspace === null, options)
  }
  if (request.flash) {
    pulseSidebarRow(session)
  }
  if (keepKeyboardFocus && typing instanceof HTMLElement) {
    holdKeyboardFocus(typing)
  }
  return { placement, keptKeyboardFocus: keepKeyboardFocus }
}
