import { useState } from 'react'
import { ClipboardCheck, ClipboardList, Lightbulb, Link2, Plus, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { sidebarSessionSourceIdentity } from '@/lib/sidebar-session-source-identity'
import { useRecoveredTaskContext } from './use-recovered-task-context'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { useSessionTask } from '@/store/session-task-store'
import { useAppStore } from '@/store'
import { AttachToTaskDialog } from './AttachToTaskDialog'
import { CreateTaskDialog } from './CreateTaskDialog'
import { SessionTaskSheet } from './SessionTaskSheet'

/**
 * The fourth control, deliberately not folded into ＋: ＋ answers "who gets this next?"
 * and needs a recipient, while this answers "this must not get lost" and needs none.
 * Once a conversation serves a task, the same control opens that task instead.
 */
export function CreateTaskButton({
  session,
  onChanged,
  visibleLabel = false
}: {
  session: SidebarSession
  onChanged?: () => void
  visibleLabel?: boolean
}): React.JSX.Element {
  const link = useSessionTask(sidebarSessionSourceIdentity(session)?.sourceKey ?? null)
  const contextReady = useRecoveredTaskContext(session, link)
  const scope = useAppStore(selectConsoleAccountScope)
  const [openedTask, setOpenedTask] = useState<{ scope: string; id: string } | null>(null)
  const openTask = (): void => {
    if (link) {
      setOpenedTask({ scope, id: link.taskId })
    }
  }
  const [open, setOpen] = useState<false | 'task' | 'proposed'>(false)
  const [attaching, setAttaching] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const tracked = link !== null
  const needsReattachment = tracked && !contextReady
  const label = needsReattachment
    ? translate('tasks.reattachForUpdates', 'Reattach for task updates')
    : tracked
      ? translate('tasks.openTask', 'Open task')
      : translate('tasks.createTask', 'Create task')
  const contextWarning = translate(
    'tasks.reattachContextOnce',
    'Reattach this conversation once to receive task context updates.'
  )
  const why = tracked
    ? translate('tasks.trackedAs', 'Tracked as “{{title}}”.', {
        title: link?.title ?? translate('tasks.aTask', 'a task')
      })
    : translate('tasks.createTaskWhy', 'Track this work until it is finished.')
  return (
    <>
      <Popover open={choosing} onOpenChange={setChoosing}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size={visibleLabel ? 'sm' : 'icon-xs'}
                aria-label={label}
                data-create-task={tracked ? 'tracked' : 'available'}
                data-task-context={needsReattachment ? 'reattach' : undefined}
                onClick={(event) => {
                  if (!tracked || needsReattachment) {
                    return
                  }
                  // Why: tracked work has one destination, so the button goes there directly.
                  event.preventDefault()
                  openTask()
                }}
              >
                {needsReattachment ? (
                  <TriangleAlert className="size-3.5 text-status-warning" />
                ) : tracked ? (
                  <ClipboardCheck className="size-3.5 text-emerald-500" />
                ) : (
                  <ClipboardList className="size-3.5" />
                )}
                {visibleLabel && label}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>
            <span className="font-medium">{label}</span>
            <span className="ml-1 text-muted-foreground">{why}</span>
            {needsReattachment && <p>{contextWarning}</p>}
          </TooltipContent>
        </Tooltip>
        <PopoverContent align="start" className="w-64 p-1" data-create-task-menu>
          {needsReattachment && (
            <p role="status" className="px-2 py-1 text-xs text-status-warning">
              {contextWarning}
            </p>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-xs"
            onClick={() => {
              setChoosing(false)
              if (tracked) {
                openTask()
              } else {
                setOpen('task')
              }
            }}
          >
            {tracked ? <ClipboardList className="size-3.5" /> : <Plus className="size-3.5" />}
            {tracked
              ? translate('tasks.openTask', 'Open task')
              : translate('tasks.createTask', 'Create task')}
          </Button>
          {!tracked && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2 text-xs"
              data-create-task-propose
              onClick={() => {
                setChoosing(false)
                setOpen('proposed')
              }}
            >
              <Lightbulb className="size-3.5" />
              {translate('tasks.proposeIdea', 'Propose an idea')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-xs"
            onClick={() => {
              setChoosing(false)
              setAttaching(true)
            }}
          >
            <Link2 className="size-3.5" />
            {needsReattachment
              ? translate('tasks.reattachForUpdates', 'Reattach for task updates')
              : translate('tasks.addToTask', 'Add to a task')}
          </Button>
          <p className="px-2 pb-1 pt-1 text-[11px] text-muted-foreground">
            {translate('tasks.createTaskWhy', 'Track this work until it is finished.')}
          </p>
        </PopoverContent>
      </Popover>
      <CreateTaskDialog
        key={open || 'closed'}
        session={open ? session : null}
        initialFiling={open === 'proposed' ? { proposed: true } : undefined}
        onOpenChange={(next) => setOpen(next ? open || 'task' : false)}
        onCreated={() => onChanged?.()}
      />
      <AttachToTaskDialog
        session={attaching ? session : null}
        onOpenChange={setAttaching}
        onAttached={() => onChanged?.()}
      />
      {openedTask?.scope === scope && (
        <SessionTaskSheet
          key={`${scope}:${openedTask.id}`}
          taskId={openedTask.id}
          scope={scope}
          onClose={() => setOpenedTask(null)}
          onChanged={onChanged}
        />
      )}
    </>
  )
}
