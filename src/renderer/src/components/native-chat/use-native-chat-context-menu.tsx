import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEventHandler,
  type RefObject
} from 'react'
import {
  Clipboard,
  ClipboardCopy,
  Ellipsis,
  Wrench,
  Copy,
  GitFork,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  PanelBottomClose,
  PanelsTopLeft,
  PanelRightClose,
  Pencil,
  X
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { isMacPlatform } from './native-chat-shortcut'

type NativeChatContextMenuState = {
  open: boolean
  point: { x: number; y: number }
  selectedText: string
}

type UseNativeChatContextMenuArgs = {
  rootRef: RefObject<HTMLElement | null>
  actions: NativeChatContextMenuActions
}

export type NativeChatContextMenuActions = {
  canManagePane?: boolean
  onPaste: () => void
  onSplitRight: () => void
  onSplitDown: () => void
  canEqualizePaneSizes: boolean
  onEqualizePaneSizes: () => void
  canExpandPane: boolean
  isPaneExpanded: boolean
  onToggleExpand: () => void
  canContinueAgentSessionInNewSession: boolean
  onContinueAgentSessionInNewSession: () => void
  onForkAgentSession: () => void
  onSetTitle: () => void
  onCopyAgentSessionContext?: () => void
  onCopyTerminalId: () => void
  onCopyPaneId: () => void
  canClosePane: boolean
  onClosePane: () => void
}

/** No-op defaults for when the view has no pane-management actions wired. */
export const emptyNativeChatContextMenuActions: Omit<NativeChatContextMenuActions, 'onPaste'> = {
  canManagePane: false,
  onSplitRight: () => {},
  onSplitDown: () => {},
  canEqualizePaneSizes: false,
  onEqualizePaneSizes: () => {},
  canExpandPane: false,
  isPaneExpanded: false,
  onToggleExpand: () => {},
  canContinueAgentSessionInNewSession: false,
  onContinueAgentSessionInNewSession: () => {},
  onForkAgentSession: () => {},
  onSetTitle: () => {},
  onCopyTerminalId: () => {},
  onCopyPaneId: () => {},
  canClosePane: false,
  onClosePane: () => {}
}

export function useNativeChatContextMenu({ rootRef, actions }: UseNativeChatContextMenuArgs): {
  onContextMenuCapture: MouseEventHandler<HTMLElement>
  onSelectionCapture: () => void
  menu: React.JSX.Element
  trigger: React.JSX.Element
} {
  const menuOpenedAtRef = useRef(0)
  const lastSelectedTextRef = useRef('')
  const [state, setState] = useState<NativeChatContextMenuState>({
    open: false,
    point: { x: 0, y: 0 },
    selectedText: ''
  })

  const rememberCurrentSelection = useCallback(() => {
    const selectedText = getNativeChatSelectedText(rootRef.current)
    if (selectedText.trim().length > 0) {
      lastSelectedTextRef.current = selectedText
    }
  }, [rootRef])

  useEffect(() => {
    document.addEventListener('selectionchange', rememberCurrentSelection)
    return () => document.removeEventListener('selectionchange', rememberCurrentSelection)
  }, [rememberCurrentSelection])

  const onContextMenuCapture = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault()
      event.stopPropagation()
      menuOpenedAtRef.current = Date.now()
      const selectedText = getNativeChatSelectedText(rootRef.current) || lastSelectedTextRef.current
      setState({
        open: true,
        point: { x: event.clientX, y: event.clientY },
        selectedText
      })
    },
    [rootRef]
  )

  const setOpen = useCallback((open: boolean) => {
    if (!open && Date.now() - menuOpenedAtRef.current < 100) {
      return
    }
    setState((prev) => ({ ...prev, open }))
  }, [])

  return {
    onContextMenuCapture,
    onSelectionCapture: rememberCurrentSelection,
    trigger: (
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute right-2 top-2 z-20 bg-background/90"
        aria-label={translate('conversations.workOptions', 'Work options')}
        onClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect()
          menuOpenedAtRef.current = Date.now()
          setState({
            open: true,
            point: { x: bounds.left, y: bounds.bottom },
            selectedText: getNativeChatSelectedText(rootRef.current)
          })
        }}
      >
        <Ellipsis className="size-3.5" />
      </Button>
    ),
    menu: (
      <DropdownMenu open={state.open} onOpenChange={setOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none fixed size-px opacity-0"
            style={{ left: state.point.x, top: state.point.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-56"
          sideOffset={0}
          align="start"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <DropdownMenuItem
            disabled={state.selectedText.trim().length === 0}
            onSelect={() => void window.api.ui.writeClipboardText(state.selectedText)}
          >
            <Copy />
            {translate('auto.components.nativeChat.contextMenu.copy', 'Copy')}
            <DropdownMenuShortcut>{isMacPlatform() ? '⌘C' : 'Ctrl+C'}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={actions.onPaste}>
            <Clipboard />
            {translate('auto.components.terminal.pane.TerminalContextMenu.0a917b591a', 'Paste')}
          </DropdownMenuItem>
          {actions.canContinueAgentSessionInNewSession ? (
            <DropdownMenuItem onSelect={actions.onContinueAgentSessionInNewSession}>
              <MessageSquarePlus />
              {translate('conversations.continueFresh', 'Continue with fresh context…')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            disabled={actions.canManagePane === false}
            onSelect={actions.onForkAgentSession}
          >
            <GitFork />
            {translate('conversations.copyWork', 'Make a copy of this work…')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={actions.canManagePane === false}
            onSelect={actions.onSplitRight}
          >
            <PanelRightClose />
            {translate('conversations.showBeside', 'Open a pane beside this work')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={actions.canManagePane === false}
            onSelect={actions.onSplitDown}
          >
            <PanelBottomClose />
            {translate('conversations.showBelow', 'Open a pane below this work')}
          </DropdownMenuItem>
          {actions.canEqualizePaneSizes ? (
            <DropdownMenuItem onSelect={actions.onEqualizePaneSizes}>
              <PanelsTopLeft />
              {translate(
                'auto.components.terminal.pane.TerminalContextMenu.06c2b0f043',
                'Equalize Pane Sizes'
              )}
            </DropdownMenuItem>
          ) : null}
          {actions.canExpandPane ? (
            <DropdownMenuItem onSelect={actions.onToggleExpand}>
              {actions.isPaneExpanded ? <Minimize2 /> : <Maximize2 />}
              {actions.isPaneExpanded
                ? translate(
                    'auto.components.terminal.pane.TerminalContextMenu.df766809e0',
                    'Collapse Pane'
                  )
                : translate(
                    'auto.components.terminal.pane.TerminalContextMenu.925f49f210',
                    'Expand Pane'
                  )}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={actions.onSetTitle}>
            <Pencil />
            {translate(
              'auto.components.terminal.pane.TerminalContextMenu.39809d152f',
              'Set Title…'
            )}
          </DropdownMenuItem>
          {actions.onCopyAgentSessionContext ? (
            <DropdownMenuItem onSelect={actions.onCopyAgentSessionContext}>
              <ClipboardCopy />
              {translate('conversations.copyContext', 'Copy work context')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Wrench />
              {translate('conversations.advanced', 'Advanced')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={actions.onCopyTerminalId}>
                <Copy />
                {translate(
                  'auto.components.terminal.pane.TerminalContextMenu.copyTerminalId',
                  'Copy Terminal ID'
                )}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={actions.onCopyPaneId}>
                <Copy />
                {translate(
                  'auto.components.terminal.pane.TerminalContextMenu.2cf85a6a55',
                  'Copy Pane ID'
                )}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {actions.canClosePane ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={actions.onClosePane}>
                <X />
                {translate(
                  'auto.components.terminal.pane.TerminalContextMenu.8c17d6786d',
                  'Close Pane'
                )}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }
}

function getNativeChatSelectedText(root: HTMLElement | null): string {
  const selection = window.getSelection()
  if (!root || !selection || selection.isCollapsed) {
    return ''
  }
  const anchor = selection.anchorNode
  const focus = selection.focusNode
  if (!nodeBelongsToRoot(anchor, root) || !nodeBelongsToRoot(focus, root)) {
    return ''
  }
  return selection.toString()
}

function nodeBelongsToRoot(node: Node | null, root: HTMLElement): boolean {
  if (!node) {
    return false
  }
  return root.contains(node)
}
