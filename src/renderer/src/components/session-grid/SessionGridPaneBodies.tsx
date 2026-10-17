import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { useAppStore } from '@/store'
import { SessionPaneBody } from '../command-center/SessionPaneBody'
import BrowserPane from '@/components/browser-pane/BrowserPane'
import { claimBrowserOverlaySlotViewport } from '@/components/browser-pane/host-guest/browser-page-viewport'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { BrowserTab as BrowserTabState } from '../../../../shared/browser-workspace-types'
import { canShowSessionTerminal } from './use-session-grid-portals'

function PaneMessage(props: {
  children: React.ReactNode
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-editor-surface p-4 text-center text-xs text-muted-foreground">
      <span>{props.children}</span>
      {props.action}
    </div>
  )
}

/**
 * A conversation's live terminal, borrowed into `onTarget`'s element (see
 * useSessionGridTerminalPortals). What shows before it paints sits behind it, so no readiness
 * gate is needed.
 */
export function SessionGridSessionBody(props: {
  session: SidebarSession | null
  onTarget: (element: HTMLElement | null) => void
  onResume: (session: SidebarSession) => void
  onOpen: (session: SidebarSession) => void
  onRemove: () => void
}): React.JSX.Element {
  const { session, onTarget } = props
  const commandCenter = useAppStore((state) => state.settings?.commandCenter === true)
  const [target, setTarget] = useState<HTMLElement | null>(null)
  const filled = useTargetFilled(target)
  const bindTarget = useCallback(
    (element: HTMLElement | null) => {
      onTarget(element)
      setTarget(element)
    },
    [onTarget]
  )
  if (!session) {
    return (
      <PaneMessage
        action={
          <Button variant="outline" size="xs" onClick={props.onRemove}>
            {translate('sessionGrid.removePane', 'Remove pane')}
          </Button>
        }
      >
        {translate('sessionGrid.sessionGone', 'This conversation is no longer in the sidebar.')}
      </PaneMessage>
    )
  }
  if (commandCenter) {
    return <SessionPaneBody session={session} onOpen={props.onOpen} />
  }
  if (session.kind === 'structured') {
    return (
      <PaneMessage
        action={
          <Button variant="outline" size="xs" onClick={() => props.onOpen(session)}>
            {translate('sessionGrid.openInWorkspace', 'Open in its workspace')}
          </Button>
        }
      >
        {translate('sessionGrid.chatElsewhere', 'Chat conversations show in their own workspace.')}
      </PaneMessage>
    )
  }
  if (!canShowSessionTerminal(session)) {
    return (
      <PaneMessage
        action={
          session.unavailable ? null : (
            <Button variant="outline" size="xs" onClick={() => props.onResume(session)}>
              {translate('sessionGrid.openHere', 'Open it here')}
            </Button>
          )
        }
      >
        {session.unavailable
          ? translate(
              'sessionGrid.sessionUnavailable',
              'This conversation cannot be reached right now.'
            )
          : translate('sessionGrid.sessionClosed', 'This conversation is not open.')}
      </PaneMessage>
    )
  }
  return (
    <>
      {filled ? null : (
        <div className="absolute inset-0 flex items-start bg-editor-surface p-3 text-xs text-muted-foreground">
          {translate(
            'auto.components.attention.AttentionPage.connectingTerminal',
            'Connecting terminal…'
          )}
        </div>
      )}
      {/* Why: Terminal stays mounted in the hidden workspace tree; this target borrows that TerminalPane instead of starting a second PTY/xterm. */}
      <div ref={bindTarget} className="absolute inset-0 min-h-0 min-w-0" />
    </>
  )
}

/** Whether the borrowed terminal has arrived in `target` (the portal renders into it). */
function useTargetFilled(target: HTMLElement | null): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!target) {
        return () => {}
      }
      const observer = new MutationObserver(onChange)
      observer.observe(target, { childList: true })
      return () => observer.disconnect()
    },
    [target]
  )
  const filled = useCallback(() => (target ? target.childElementCount > 0 : false), [target])
  return useSyncExternalStore(subscribe, filled, filled)
}

/**
 * A browser tab shown in the grid. Its pages live in this pane's slot while the pane is up and
 * go back to the tab's own slot when it closes (claimBrowserOverlaySlotViewport).
 */
export function SessionGridBrowserBody(props: {
  browserTab: BrowserTabState | null
  focused: boolean
  visible?: boolean
  onRemove: () => void
}): React.JSX.Element {
  const { browserTab } = props
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const tabId = browserTab?.id ?? null
  const release = useRef<(() => void) | null>(null)
  // Why claim in the ref: the pages must find this slot before BrowserPane's own effects run.
  const claimRoot = useCallback(
    (node: HTMLDivElement | null) => {
      release.current?.()
      release.current = node && tabId ? claimBrowserOverlaySlotViewport(tabId, node) : null
      setRoot(node)
    },
    [tabId]
  )
  if (!browserTab) {
    return (
      <PaneMessage
        action={
          <Button variant="outline" size="xs" onClick={props.onRemove}>
            {translate('sessionGrid.removePane', 'Remove pane')}
          </Button>
        }
      >
        {translate('sessionGrid.browserGone', 'This browser tab was closed.')}
      </PaneMessage>
    )
  }
  return (
    <div className="absolute inset-0 flex min-h-0 flex-col">
      <div ref={claimRoot} className="absolute inset-0 flex min-h-0 flex-col" />
      {root ? (
        <BrowserPane
          browserTab={browserTab}
          // Hidden panes retain the browser but release its active viewport.
          isActive={props.visible ?? true}
          chromeShortcutScope={props.focused ? 'focused' : 'inactive'}
        />
      ) : null}
    </div>
  )
}

/** A scratch notepad kept with the grid on this device. */
export function SessionGridNotepadBody(props: {
  text: string
  onChange: (text: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(props.text)
  const { onChange } = props
  const latest = useRef({ draft, saved: props.text, onChange })
  useLayoutEffect(() => {
    latest.current = { draft, saved: props.text, onChange }
  })
  // Why a short delay: saving the whole grid on every keystroke would stutter long notes.
  useEffect(() => {
    if (draft === props.text) {
      return
    }
    const timer = window.setTimeout(() => onChange(draft), 300)
    return () => window.clearTimeout(timer)
  }, [draft, onChange, props.text])
  // Why: closing or minimizing the pane mid-typing must not drop the last words.
  useEffect(
    () => () => {
      const { draft: pending, saved, onChange: save } = latest.current
      if (pending !== saved) {
        save(pending)
      }
    },
    []
  )
  const flush = useCallback(() => {
    if (draft !== props.text) {
      onChange(draft)
    }
  }, [draft, onChange, props.text])
  return (
    <textarea
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={flush}
      spellCheck
      aria-label={translate('sessionGrid.notepad', 'Notepad')}
      placeholder={translate('sessionGrid.notepadPlaceholder', 'Notes, links, next steps…')}
      className="absolute inset-0 resize-none bg-editor-surface p-3 font-mono text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
    />
  )
}
