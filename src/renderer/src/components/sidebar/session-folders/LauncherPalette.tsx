import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { beginLaunchIntentDrag, clearLaunchIntentDrag } from '@/lib/launcher-intent-drag'
import type { HoverOpenContentProps } from '@/components/next-step/use-hover-open-popover'
import type {
  AccountCapacityRow,
  CapacityProvider
} from '../../../../../shared/provider-account-capacity'
import {
  LAUNCHER_PROVIDERS,
  type LaunchPick,
  type LauncherCapability,
  type LauncherProvider
} from './new-conversation/resolve-launch-plan'
import {
  LauncherProviderSubmenu,
  providerHasLaunchSubmenu
} from './new-conversation/LauncherProviderSubmenu'

const LONG_PRESS_MS = 500

// Why: the right-click menu is opened by a click, not by hovering the "+", so it needs none of
// the hover-open wiring the "+" menu hands its submenus.
const NO_HOVER: HoverOpenContentProps = {
  onPointerMove: () => {},
  onPointerEnter: () => {},
  onPointerLeave: () => {},
  onPointerDownCapture: () => {},
  onInteractOutside: () => {},
  onOpenAutoFocus: () => {},
  onCloseAutoFocus: () => {}
}

type LauncherPaletteProps = {
  capabilities: LauncherCapability[]
  rows: Record<CapacityProvider, AccountCapacityRow[]>
  local: boolean
  starting: boolean
  launchError: string
  /** The "+" menu row's own launch: the caller wraps the pick with the launcher's template. */
  start: (pick: LaunchPick) => void
}

/**
 * One icon per usable launcher provider beside the sidebar "+". A click is the provider row's
 * launch, right-click (or a touch long-press) opens that row's submenu at the pointer, and a drag
 * carries the provider onto a session row or folder heading.
 */
export function LauncherPalette(props: LauncherPaletteProps): React.JSX.Element {
  return (
    <>
      {LAUNCHER_PROVIDERS.map((agent) => {
        const entry = props.capabilities.find(
          (item) => item.id === agent && item.status === 'usable'
        )
        return entry ? <PaletteProvider key={agent} {...props} entry={entry} agent={agent} /> : null
      })}
    </>
  )
}

function PaletteProvider({
  agent,
  entry,
  ...props
}: LauncherPaletteProps & {
  agent: LauncherProvider
  entry: LauncherCapability
}): React.JSX.Element {
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })
  const [menuOpen, setMenuOpen] = useState(false)
  // Why: the menu's own trigger is an invisible point, so dismissal returns focus here instead.
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const interactedOutside = useRef(false)
  // Why: the release that ends a long-press still produces a click; it must not also launch.
  const suppressClick = useRef(false)
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasSubmenu = providerHasLaunchSubmenu(agent)
  const cancelLongPress = (): void => {
    if (longPress.current) {
      clearTimeout(longPress.current)
      longPress.current = null
    }
  }
  // Why: this icon's own drag. An icon that unmounts mid-drag (its provider stopped being
  // usable) never receives dragend, so it ends its drag as it leaves.
  const dragOwner = useRef<symbol | null>(null)
  const endDrag = (): void => {
    if (dragOwner.current) {
      clearLaunchIntentDrag(dragOwner.current)
      dragOwner.current = null
    }
  }
  useEffect(
    () => () => {
      cancelLongPress()
      if (dragOwner.current) {
        clearLaunchIntentDrag(dragOwner.current)
      }
    },
    []
  )
  const openMenu = (x: number, y: number): boolean => {
    if (!hasSubmenu || props.starting) {
      return false
    }
    interactedOutside.current = false
    setMenuPoint({ x, y })
    setMenuOpen(true)
    return true
  }
  const label = translate('launcherPalette.launch', 'Launch {{provider}} here', {
    provider: entry.label
  })
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-xs"
            variant="ghost"
            className="text-muted-foreground"
            disabled={props.starting}
            aria-label={label}
            draggable={!props.starting}
            onClick={() => {
              if (suppressClick.current) {
                suppressClick.current = false
                return
              }
              props.start({ agent })
            }}
            onContextMenu={(event) => {
              // Why: a provider without a submenu has nothing to choose; right-click does nothing.
              event.preventDefault()
              buttonRef.current = event.currentTarget
              openMenu(event.clientX, event.clientY)
            }}
            onPointerDown={(event) => {
              buttonRef.current = event.currentTarget
              suppressClick.current = false
              cancelLongPress()
              // Why: a held mouse button is how a drag begins; only touch and pen long-press.
              if (event.pointerType === 'mouse' || event.button !== 0) {
                return
              }
              const { clientX, clientY } = event
              longPress.current = setTimeout(() => {
                longPress.current = null
                if (openMenu(clientX, clientY)) {
                  suppressClick.current = true
                }
              }, LONG_PRESS_MS)
            }}
            onPointerUp={cancelLongPress}
            onPointerLeave={cancelLongPress}
            onPointerCancel={cancelLongPress}
            onDragStart={(event) => {
              cancelLongPress()
              event.dataTransfer.effectAllowed = 'copy'
              dragOwner.current = beginLaunchIntentDrag(event.dataTransfer, { agent })
            }}
            onDragEnd={endDrag}
          >
            <AgentIcon agent={agent} size={16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {translate(
            'launcherPalette.tooltip',
            'Launch {{provider}} here · drag onto a session or folder · right-click for account, model, effort',
            { provider: entry.label }
          )}
        </TooltipContent>
      </Tooltip>
      {hasSubmenu ? (
        // Why the invisible trigger at the pointer: the same pattern the tab context menus use,
        // so the "+" menu's own submenu components render unchanged inside a real DropdownMenu.
        <DropdownMenu open={menuOpen} modal={false} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              aria-hidden
              tabIndex={-1}
              className="pointer-events-none fixed size-px opacity-0"
              style={{ left: menuPoint.x, top: menuPoint.y }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            sideOffset={0}
            className="max-h-96 w-80 overflow-y-auto scrollbar-sleek"
            onInteractOutside={() => {
              interactedOutside.current = true
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              // Why: a click elsewhere keeps the focus it gave; otherwise (Escape, a chosen
              // item, or a click on nothing focusable) focus returns to this icon, not the body.
              const focused = document.activeElement
              if (interactedOutside.current && focused && focused !== document.body) {
                return
              }
              buttonRef.current?.focus()
            }}
          >
            <LauncherProviderSubmenu
              agent={agent}
              entry={entry}
              rows={props.rows}
              local={props.local}
              hover={NO_HOVER}
              starting={props.starting}
              launchError={props.launchError}
              start={(pick) => {
                setMenuOpen(false)
                props.start(pick)
              }}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </>
  )
}
