import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import { translate } from '@/i18n/i18n'
import {
  equalShares,
  resizeSessionGridShares,
  type SessionGridLayout
} from '@/lib/session-grid-layout'
import {
  sessionGridDividerShare,
  sessionGridGeometry,
  type SessionGridBox,
  type SessionGridDivider
} from '@/lib/session-grid-geometry'
import { cn } from '@/lib/utils'
import { useSessionGridDrop } from './use-session-grid-drop'

const pct = (value: number): string => `${value * 100}%`

function withDividerShare(
  layout: SessionGridLayout,
  divider: SessionGridDivider,
  share: number | 'equal'
): SessionGridLayout {
  if (divider.kind === 'track') {
    return {
      ...layout,
      trackSizes:
        share === 'equal'
          ? equalShares(layout.trackSizes.length)
          : resizeSessionGridShares(layout.trackSizes, divider.index, share)
    }
  }
  return {
    ...layout,
    paneSizes: layout.paneSizes.map((shares, track) =>
      track !== divider.track
        ? shares
        : share === 'equal'
          ? equalShares(shares.length)
          : resizeSessionGridShares(shares, divider.index, share)
    )
  }
}

function dividerStyle(divider: SessionGridDivider): React.CSSProperties {
  const { box } = divider
  return divider.axis === 'x'
    ? { left: `calc(${pct(box.left)} - 4px)`, top: pct(box.top), width: 8, height: pct(box.height) }
    : { top: `calc(${pct(box.top)} - 4px)`, left: pct(box.left), height: 8, width: pct(box.width) }
}

function boxStyle(box: SessionGridBox): React.CSSProperties {
  return { left: pct(box.left), top: pct(box.top), width: pct(box.width), height: pct(box.height) }
}

/**
 * The grid's surface: panes placed by the layout, dividers that resize (double-click evens a
 * row out), and the drop cover that shows where a dragged session or tab will land.
 */
export function SessionGridCanvas(props: {
  layout: SessionGridLayout
  renderPane: (paneId: string) => React.ReactNode
  onResize: (layout: SessionGridLayout) => void
  maximizedPaneId?: string | null
  empty: React.ReactNode
}): React.JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [override, setOverride] = useState<SessionGridLayout | null>(null)
  const layout = override ?? props.layout
  const geometry = useMemo(() => sessionGridGeometry(layout), [layout])
  const drop = useSessionGridDrop(bodyRef)
  const [resizeAxis, setResizeAxis] = useState<'x' | 'y' | null>(null)
  const { onResize } = props

  const commit = useCallback(
    (next: SessionGridLayout) => {
      onResize(next)
      // Why: every borrowed terminal changed size; refit so each PTY's columns follow.
      window.dispatchEvent(new Event(SYNC_FIT_PANES_EVENT))
    },
    [onResize]
  )

  const startResize = (
    divider: SessionGridDivider,
    event: React.PointerEvent<HTMLElement>
  ): void => {
    const body = bodyRef.current
    if (!body || event.button !== 0) {
      return
    }
    event.preventDefault()
    const base = props.layout
    let latest = base
    setResizeAxis(divider.axis)
    const move = (next: PointerEvent): void => {
      const share = sessionGridDividerShare({
        divider,
        layout: base,
        pointer: { x: next.clientX, y: next.clientY },
        rect: body.getBoundingClientRect()
      })
      latest = withDividerShare(base, divider, share)
      setOverride(latest)
    }
    const finish = (): void => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', finish, true)
      window.removeEventListener('pointercancel', finish, true)
      setResizeAxis(null)
      setOverride(null)
      if (latest !== base) {
        commit(latest)
      }
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', finish, true)
    window.addEventListener('pointercancel', finish, true)
  }

  useEffect(() => {
    if (props.maximizedPaneId !== undefined) {
      window.dispatchEvent(new Event(SYNC_FIT_PANES_EVENT))
    }
  }, [props.maximizedPaneId])
  const paneIds = layout.tracks.flat()
  return (
    <div
      ref={bodyRef}
      className="relative min-h-0 flex-1 overflow-hidden bg-muted/20"
      data-session-grid-body=""
    >
      {paneIds.length === 0 ? props.empty : null}
      {paneIds.map((paneId) => {
        const box = geometry.panes.get(paneId)
        return box ? (
          <div
            key={paneId}
            className="absolute p-[3px]"
            data-grid-pane-visible={!props.maximizedPaneId || props.maximizedPaneId === paneId}
            style={
              props.maximizedPaneId
                ? props.maximizedPaneId === paneId
                  ? { inset: 0 }
                  : { ...boxStyle(box), visibility: 'hidden', pointerEvents: 'none' }
                : boxStyle(box)
            }
            inert={Boolean(props.maximizedPaneId && props.maximizedPaneId !== paneId)}
          >
            {props.renderPane(paneId)}
          </div>
        ) : null
      })}
      {!props.maximizedPaneId &&
        geometry.dividers.map((divider) => (
          <div
            key={
              divider.kind === 'track'
                ? `track:${divider.index}`
                : `pane:${divider.track}:${divider.index}`
            }
            role="separator"
            aria-orientation={divider.axis === 'x' ? 'vertical' : 'horizontal'}
            aria-label={translate('sessionGrid.resize', 'Drag to resize; double-click to even out')}
            title={translate('sessionGrid.resize', 'Drag to resize; double-click to even out')}
            onPointerDown={(event) => startResize(divider, event)}
            onDoubleClick={() => commit(withDividerShare(props.layout, divider, 'equal'))}
            className={cn(
              'group absolute z-10 flex items-center justify-center',
              divider.axis === 'x' ? 'cursor-col-resize' : 'cursor-row-resize'
            )}
            style={dividerStyle(divider)}
          >
            <span
              className={cn(
                'rounded-full bg-transparent transition-colors group-hover:bg-ring/60',
                divider.axis === 'x' ? 'h-full w-0.5' : 'h-0.5 w-full'
              )}
            />
          </div>
        ))}
      {resizeAxis ? (
        // Why: a webview or terminal under the pointer would swallow the drag's pointer events.
        <div
          className={cn(
            'absolute inset-0 z-40',
            resizeAxis === 'x' ? 'cursor-col-resize' : 'cursor-row-resize'
          )}
        />
      ) : null}
      {drop.active ? (
        <div
          className="absolute inset-0 z-40"
          data-session-grid-drop-cover=""
          onDragOver={drop.onDragOver}
          onDrop={drop.onDrop}
        >
          {drop.target ? (
            <div
              className="pointer-events-none absolute rounded-md border-2 border-ring bg-ring/15 transition-all"
              style={{
                left: drop.target.box.left,
                top: drop.target.box.top,
                width: drop.target.box.width,
                height: drop.target.box.height
              }}
            >
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md bg-background/90 px-2 py-1 text-xs font-medium shadow-sm">
                {drop.target.paneId === null
                  ? translate('sessionGrid.dropAdd', 'Add to the grid')
                  : drop.target.zone === 'center'
                    ? translate('sessionGrid.dropReplace', 'Put it here')
                    : translate('sessionGrid.dropBeside', 'Put it beside')}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
