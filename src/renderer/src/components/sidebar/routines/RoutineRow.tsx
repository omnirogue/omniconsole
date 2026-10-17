import { useRoutineTeamLink, viewTeamRoutine } from './routine-team-links'
import { routineTeamCopy as copy } from './routine-team-copy'
import { useRef, useState } from 'react'
import type { Automation } from '../../../../../shared/automations-types'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { translate } from '@/i18n/i18n'
import type { SessionFolder } from '@/lib/session-folders'
import { readSessionSidebarDrag, readSessionSidebarDragKind } from '@/lib/session-sidebar-drag'
import { sessionSidebarDensity } from '@/lib/session-sidebar-view'
import { cn } from '@/lib/utils'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { ConversationRenameField } from '../session-folders/ConversationRenameField'
import { ConversationRowTitle } from '../session-folders/ConversationRowTitle'
import { RoutineRowActions } from './RoutineRowActions'
import { RoutineRowCluster } from './RoutineRowCluster'
import { RoutineRowHoverCard } from './RoutineRowHoverCard'
import { RoutineStateIcon } from './RoutineStateIcon'
import type { RoutineCommands } from './routine-row-commands'
import { routineRowCaption, routineRowIndicator, routineRowState } from './routine-row-details'

/** A popover or menu opened from this row: Radix marks its trigger expanded while it is up. */
const OPEN_ROW_MENU = '[aria-haspopup][aria-expanded="true"]'

type Props = {
  automation: Automation
  routineKey: string
  /** The routine whose conversation or settings are open. */
  current: boolean
  /** This row's conversation is being opened; the row dims, the list stays live. */
  opening: boolean
  hidden: boolean
  /** The row sits under Archived. */
  archived: boolean
  folders: readonly SessionFolder[]
  folderId: string | null
  commands: RoutineCommands
  onOpen: () => void
  /** In the multi-selection; with `onToggleSelected`, the row leads with the same checkbox a conversation has. */
  selected?: boolean
  onToggleSelected?: () => void
  onDropRow?: (key: string) => void
  onDragStart?: (event: React.DragEvent<HTMLDivElement>) => void
  onDragEnd?: (event: React.DragEvent<HTMLDivElement>) => void
}

export function RoutineRow({
  automation,
  routineKey,
  current,
  opening,
  hidden,
  archived,
  folders,
  folderId,
  commands,
  onOpen,
  selected = false,
  onToggleSelected,
  onDropRow,
  onDragStart,
  onDragEnd
}: Props): React.JSX.Element {
  const link = useRoutineTeamLink(automation.id)
  const [renaming, setRenaming] = useState(false)
  const openRef = useRef<HTMLButtonElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  // Why: one density for the whole sidebar — the Conversations "Compact rows" toggle rules here too.
  const compact = useSessionSidebarView((state) => sessionSidebarDensity(state.view) === 'compact')
  // Why: selecting text in the name field must not pick the row up.
  const draggable = Boolean(onDragStart) && !renaming
  const caption = routineRowCaption(automation)
  const state = routineRowState(automation)
  const indicator = compact ? routineRowIndicator(automation) : null
  const rename = (title: string | null): void => {
    // Why: a routine always keeps a name; clearing the field is not a request for a generated one.
    if (title) {
      void commands.rename(automation, title)
    }
  }
  return (
    <div
      ref={rowRef}
      className={cn(
        'group flex items-center rounded-md text-worktree-sidebar-foreground hover:bg-worktree-sidebar-accent',
        selected && 'bg-worktree-sidebar-accent/60 ring-1 ring-inset ring-worktree-sidebar-ring',
        current && 'bg-worktree-sidebar-accent',
        opening && 'opacity-60',
        draggable && 'cursor-grab active:cursor-grabbing'
      )}
      data-current={current || undefined}
      data-selected={selected || undefined}
      data-routine-row={automation.id}
      data-routine-key={routineKey}
      data-routine-density={compact ? 'compact' : 'comfortable'}
      aria-busy={opening || undefined}
      draggable={draggable || undefined}
      onDragStart={draggable ? onDragStart : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
      onDragOver={(event) => {
        if (onDropRow && readSessionSidebarDragKind(event.dataTransfer.types) === 'row') {
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'move'
        }
      }}
      onDrop={(event) => {
        const drag = readSessionSidebarDrag(event.dataTransfer)
        if (onDropRow && drag?.kind === 'row') {
          event.preventDefault()
          event.stopPropagation()
          onDropRow(drag.sessionKey)
        }
      }}
    >
      {onToggleSelected ? (
        <Checkbox
          className="ml-1 shrink-0"
          checked={selected}
          aria-label={translate('routines.selectRoutine', 'Select {{name}}', {
            name: automation.name
          })}
          onCheckedChange={onToggleSelected}
        />
      ) : null}
      {renaming ? (
        <div
          className={cn(
            'flex min-w-0 flex-1 items-center px-2',
            compact ? 'gap-1.5 py-1' : 'gap-2 py-2'
          )}
          data-routine-renaming=""
        >
          <RoutineStateIcon state={state} size={compact ? 'sm' : 'md'} />
          <span className="min-w-0 flex-1">
            <ConversationRenameField
              title={automation.name}
              onRename={rename}
              onDone={(fromKeyboard) => {
                setRenaming(false)
                if (fromKeyboard) {
                  requestAnimationFrame(() => openRef.current?.focus())
                }
              }}
            />
            {compact ? null : (
              <span className="block truncate text-xs text-muted-foreground">{caption[0]}</span>
            )}
          </span>
        </div>
      ) : null}
      <RoutineRowHoverCard
        automation={automation}
        archived={archived}
        target={commands.target}
        isBusy={() => rowRef.current?.querySelector(OPEN_ROW_MENU) !== null}
      >
        <Button
          ref={openRef}
          hidden={renaming}
          variant="ghost"
          className={cn(
            'h-auto min-w-0 flex-1 justify-start px-2 text-left hover:bg-transparent hover:text-worktree-sidebar-accent-foreground',
            compact ? 'gap-1.5 py-1 leading-tight' : 'gap-2 py-2'
          )}
          disabled={opening}
          data-routine-open=""
          aria-keyshortcuts="F2"
          aria-label={translate('routines.openRoutine', 'Open routine {{name}}', {
            name: automation.name
          })}
          onClick={onOpen}
          onKeyDown={(event) => {
            if (
              event.key === 'F2' &&
              !(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
            ) {
              event.preventDefault()
              event.stopPropagation()
              setRenaming(true)
            }
          }}
        >
          <RoutineStateIcon state={state} size={compact ? 'sm' : 'md'} />
          {compact ? (
            <span className="min-w-0 flex-1" data-routine-row-line="">
              <ConversationRowTitle
                title={automation.name}
                onStartRename={() => setRenaming(true)}
              />
            </span>
          ) : (
            <span className="min-w-0 flex-1">
              <ConversationRowTitle
                title={automation.name}
                onStartRename={() => setRenaming(true)}
              />
              {caption.map((line) => (
                <span
                  key={line}
                  className="block truncate text-xs font-normal text-muted-foreground"
                  data-routine-caption=""
                >
                  {line}
                </span>
              ))}
              {archived ? (
                <span
                  className="block truncate text-xs font-normal text-muted-foreground"
                  data-routine-archived=""
                >
                  {translate('conversations.archivedByYou', 'Archived')}
                </span>
              ) : null}
            </span>
          )}
        </Button>
      </RoutineRowHoverCard>
      {link?.state === 'linked' ? (
        <Button variant="link" size="xs" onClick={() => viewTeamRoutine(link.teamRoutineId)}>
          {copy.moved()}
        </Button>
      ) : null}
      {/* Why: a compact row says "Paused" with its at-rest mark instead, over the action cluster. */}
      {!compact && !automation.enabled ? (
        <span className="shrink-0 text-xs text-muted-foreground" data-routine-paused="">
          {translate('routines.paused', 'Paused')}
        </span>
      ) : null}
      <RoutineRowCluster compact={compact} indicator={indicator}>
        <RoutineRowActions
          automation={automation}
          routineKey={routineKey}
          hidden={hidden}
          folders={folders}
          folderId={folderId}
          commands={commands}
        />
      </RoutineRowCluster>
    </div>
  )
}
