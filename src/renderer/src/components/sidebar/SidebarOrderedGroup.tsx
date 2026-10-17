import React, { useMemo } from 'react'
import { SidebarRowMenu } from './SidebarRowMenu'
import { isSidebarMemberScope } from '../../../../shared/sidebar-navigation-placement'
import { ArrowDown, ArrowUp, EyeOff, GripVertical } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import {
  beginSidebarDrag,
  clearSidebarDrag,
  dropSideOf,
  SIDEBAR_DRAG_MIME,
  sidebarDragInFlight,
  useSidebarDrag
} from './sidebar-drag'
import {
  EMPTY_SIDEBAR_LAYOUT,
  moveBy,
  orderedIds,
  place,
  type DropSide
} from '../../../../shared/sidebar-layout'

export type OrderedSidebarItem = {
  id: string
  /** Shown in the restore list and in every control's accessible name. */
  label: string
  node: React.ReactNode
  /**
   * Draw this row even when the person hid it, because it carries something that
   * needs them. Collapsed, never hidden.
   */
  reveal?: boolean
}

/**
 * A reorderable, hideable group of sidebar rows.
 *
 * Every row is draggable with no mode to enable; the hide and keyboard-move
 * controls appear only while Customize is on, so an ordinary hover does not offer
 * a destructive-looking eye icon. Drag and drop is native HTML5 plus the
 * page-wide `sidebar-drag` record — see that file for why the record is deferred
 * by a tick.
 */
export function SidebarOrderedGroup({
  scope,
  items,
  rowDrag = true,
  hideable = true,
  className
}: {
  scope: string
  items: readonly OrderedSidebarItem[]
  /** False for the nav groups: a drag on every hover there would invite accidents. */
  rowDrag?: boolean
  /** Personal company eyes own visibility independently of the generic layout controls. */
  hideable?: boolean
  className?: string
}): React.JSX.Element {
  // Why the fallback: a hydrated state or a paired client from before this field
  // existed must mean "the built-in order", never a crash that blanks the sidebar.
  const layout = useAppStore((state) => state.sidebarLayout ?? EMPTY_SIDEBAR_LAYOUT)
  const customize = useAppStore((state) => state.sidebarCustomizing === true)
  const setOrder = useAppStore((state) => state.setSidebarOrder)
  const moveMember = useAppStore((state) => state.moveSidebarMember)
  const hideRow = useAppStore((state) => state.hideSidebarRow)
  const drag = useSidebarDrag()
  const [over, setOver] = React.useState<{ id: string; side: DropSide } | null>(null)

  const order = useMemo(
    () =>
      orderedIds(
        items.map((item) => item.id),
        layout.orders[scope]
      ),
    [items, layout.orders, scope]
  )
  const visible = useMemo(
    () =>
      order
        .map((id) => items.find((item) => item.id === id))
        .filter((item): item is OrderedSidebarItem => item !== undefined)
        // Why reveal wins: a per-person preference may not hide work that needs a human.
        .filter(
          (item) => !hideable || !Object.hasOwn(layout.hidden, item.id) || item.reveal === true
        ),
    [order, items, layout.hidden, hideable]
  )
  const acceptsScope = (source: string): boolean =>
    source === scope || (isSidebarMemberScope(scope) && isSidebarMemberScope(source))
  const ownDrag = drag !== null && acceptsScope(drag.scope)

  const commit = (id: string, target: string, side: DropSide): void => {
    if (isSidebarMemberScope(scope)) {
      moveMember(id, scope, order, target, side)
    } else {
      setOrder(scope, place(order, id, target, side))
    }
  }

  return (
    <div className={cn('flex flex-col gap-0.5', className)} data-sidebar-scope={scope}>
      {visible.map((item, index) => {
        const active = drag?.id === item.id && ownDrag
        const indicator = over?.id === item.id && ownDrag ? over.side : null
        return (
          <div
            key={item.id}
            className={cn(
              'group/ordered relative rounded-md has-[>[data-sidebar-row-header]:empty]:hidden',
              isSidebarMemberScope(scope) && 'group/member',
              indicator === 'before' && 'shadow-[inset_0_2px_0_0_hsl(var(--primary))]',
              indicator === 'after' && 'shadow-[inset_0_-2px_0_0_hsl(var(--primary))]',
              active && 'opacity-40'
            )}
            data-sidebar-row={item.id}
            data-drop={indicator ?? undefined}
            draggable={rowDrag || customize}
            onDragStart={(event) => {
              // Why the identity check: a drag started on a link inside the row is
              // that link's drag, not a reorder.
              if (
                event.target !== event.currentTarget &&
                !(event.target as HTMLElement).closest('[data-sidebar-drag-handle]')
              ) {
                return
              }
              event.stopPropagation()
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData(SIDEBAR_DRAG_MIME, JSON.stringify({ scope, id: item.id }))
              beginSidebarDrag({ scope, id: item.id, label: item.label })
            }}
            onDragOver={(event) => {
              const source = sidebarDragInFlight()
              if (!source || !acceptsScope(source.scope)) {
                return
              }
              event.preventDefault()
              event.stopPropagation()
              event.dataTransfer.dropEffect = 'move'
              setOver({ id: item.id, side: dropSideOf(event) })
            }}
            onDragLeave={() => setOver((value) => (value?.id === item.id ? null : value))}
            onDrop={(event) => {
              const inFlight = sidebarDragInFlight()
              if (!inFlight || !acceptsScope(inFlight.scope)) {
                return
              }
              event.preventDefault()
              event.stopPropagation()
              commit(inFlight.id, item.id, dropSideOf(event))
              setOver(null)
              clearSidebarDrag()
            }}
            onDragEnd={() => {
              setOver(null)
              clearSidebarDrag()
            }}
          >
            <div data-sidebar-row-header="">{item.node}</div>
            {!customize && hideable && isSidebarMemberScope(scope) ? (
              <div className="absolute right-1 top-1/2 -translate-y-1/2 rounded bg-sidebar opacity-0 group-hover/member:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100">
                <SidebarRowMenu id={item.id} label={item.label} scope={scope} />
              </div>
            ) : null}
            {customize ? (
              <div
                className={cn(
                  'absolute right-1 flex items-center gap-0.5 rounded bg-background/90 px-0.5',
                  scope === 'nav' ? 'top-1' : 'top-1/2 -translate-y-1/2'
                )}
              >
                <span
                  draggable
                  data-sidebar-drag-handle=""
                  aria-label={translate('sidebar.dragRow', 'Drag {{label}}', { label: item.label })}
                  title={translate('sidebar.dragRow', 'Drag {{label}}', { label: item.label })}
                  className="cursor-grab text-muted-foreground"
                >
                  <GripVertical className="size-3" aria-hidden />
                </span>
                <button
                  type="button"
                  disabled={index === 0}
                  aria-label={translate('sidebar.moveUp', 'Move {{label}} up', {
                    label: item.label
                  })}
                  onClick={() => setOrder(scope, moveBy(order, item.id, -1))}
                  className="text-muted-foreground disabled:opacity-30"
                >
                  <ArrowUp className="size-3" aria-hidden />
                </button>
                <button
                  type="button"
                  disabled={index === visible.length - 1}
                  aria-label={translate('sidebar.moveDown', 'Move {{label}} down', {
                    label: item.label
                  })}
                  onClick={() => setOrder(scope, moveBy(order, item.id, 1))}
                  className="text-muted-foreground disabled:opacity-30"
                >
                  <ArrowDown className="size-3" aria-hidden />
                </button>
                {hideable && isSidebarMemberScope(scope) ? (
                  <SidebarRowMenu id={item.id} label={item.label} scope={scope} />
                ) : null}
                {hideable ? (
                  <button
                    type="button"
                    aria-label={translate('sidebar.hideRow', 'Hide {{label}} from the sidebar', {
                      label: item.label
                    })}
                    onClick={() => hideRow(item.id, item.label)}
                    className="text-muted-foreground"
                  >
                    <EyeOff className="size-3" aria-hidden />
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
