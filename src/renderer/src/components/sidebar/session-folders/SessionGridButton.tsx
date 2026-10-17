import { useEffect, useRef, useState } from 'react'
import { LayoutGrid } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useSessionGrid } from '@/store/session-grid'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import {
  captureSessionGridDrag,
  dropOnSessionGrid,
  type SessionGridDragCapture
} from '@/lib/session-grid-actions'
import { isSessionGridView } from '@/lib/command-center-navigation'
import { openSessionGrid } from '@/lib/session-grid-open'
import { isSessionGridDropTypes } from '@/lib/session-grid-drag'
import { cn } from '@/lib/utils'

/**
 * Opens the Grid (or goes back to the workspace), showing how many panes it holds. Sessions
 * dragged onto it join the grid without leaving the list.
 */
export function SessionGridButton(): React.JSX.Element {
  const load = useSessionGrid((state) => state.load)
  const commandCenter = useAppStore((state) => state.settings?.commandCenter === true)
  const accountScope = useHandoffScope()
  const count = useSessionGrid((state) =>
    state.layout.tracks.reduce((sum, track) => sum + track.length, 0)
  )
  const active = useAppStore((state) =>
    isSessionGridView(state.activeView, state.settings?.commandCenter)
  )
  const [over, setOver] = useState(false)
  const captured = useRef<SessionGridDragCapture | null>(null)
  useEffect(() => {
    load(commandCenter)
  }, [load, commandCenter, accountScope])
  const label = active
    ? translate('sessionGrid.backToWorkspace', 'Back to the workspace view')
    : count > 0
      ? translate('sessionGrid.openWithCount', 'Open the grid ({{count}} panes)', { count })
      : translate(
          'sessionGrid.openEmpty',
          'Open the grid — drag sessions here to show several at once'
        )
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label={label}
      title={label}
      aria-pressed={active}
      data-session-grid-button=""
      onClick={() =>
        active ? useAppStore.getState().setActiveView('terminal') : openSessionGrid()
      }
      onDragOver={(event) => {
        if (isSessionGridDropTypes(event.dataTransfer.types)) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          captured.current = captureSessionGridDrag()
          setOver(true)
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false)
        if (!isSessionGridDropTypes(event.dataTransfer.types)) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        const drag = captured.current ?? captureSessionGridDrag()
        captured.current = null
        if (dropOnSessionGrid(null, drag)) {
          openSessionGrid()
        }
      }}
      className={cn(
        'relative text-muted-foreground',
        active && 'bg-accent text-foreground',
        over && 'ring-2 ring-ring'
      )}
    >
      <LayoutGrid className="size-3.5" />
      {count > 0 ? (
        <span className="absolute -right-0.5 -top-0.5 min-w-3 rounded-full bg-foreground px-0.5 text-[9px] font-semibold leading-3 text-background tabular-nums">
          {count}
        </span>
      ) : null}
    </Button>
  )
}
