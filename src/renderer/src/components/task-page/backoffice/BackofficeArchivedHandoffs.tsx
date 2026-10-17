import { useEffect, useState } from 'react'
import { handoffApi } from '@/components/handoffs/handoff-client'
import { HandoffDetailView } from '@/components/handoffs/HandoffDetailView'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { translate } from '@/i18n/i18n'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { workflowData } from '@/lib/console-workflow-client'
import { useAppStore } from '@/store'
import { receivedRow, sentRow } from '../../../../../shared/backoffice-work-rows'
import type { HandoffQueue } from '../../../../../shared/console-handoff-contract'
import { BackofficeActionList } from './BackofficeActionList'
import { BackofficeWorkFilterRow } from './backoffice-work-filter-row'
import { collectQueuePages } from './backoffice-work-pages'
import {
  EMPTY_WORK_FILTER,
  filterWorkRows,
  workFilterChoices,
  type WorkFilter
} from './backoffice-work-labels'

type ArchiveProps = {
  scope: string
  viewer: string | null
  names: ReadonlyMap<string, string>
  filter?: WorkFilter
  onOpenTask?: (taskId: string) => void
  deleted?: boolean
}

export function BackofficeArchivedHandoffs(props: ArchiveProps) {
  const [open, setOpen] = useState(false)
  const title = props.deleted
    ? translate('inbox.deletedHandoffs', 'Deleted handoffs')
    : translate('workActions.archivedHandoffs', 'Archived handoffs')
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button size="xs" variant="ghost" disabled={!props.viewer} onClick={() => setOpen(true)}>
        {title}
      </Button>
      <SheetContent className="w-full sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>
            {props.deleted
              ? translate(
                  'inbox.deletedExplanation',
                  'Deleted from your inbox. Restore a message to bring it back.'
                )
              : translate(
                  'workActions.archiveExplanation',
                  'Archived only for you. Restore an item to return it to your lists.'
                )}
          </SheetDescription>
        </SheetHeader>
        {open ? <ArchivedHandoffList key={`${props.scope}:${props.viewer}`} {...props} /> : null}
      </SheetContent>
    </Sheet>
  )
}

function ArchivedHandoffList({
  scope,
  viewer,
  names,
  filter: initialFilter,
  onOpenTask
}: ArchiveProps) {
  const [queue, setQueue] = useState<HandoffQueue | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [pages, setPages] = useState(4)
  const [filter, setFilter] = useState<WorkFilter>(() => ({
    ...(initialFilter ?? EMPTY_WORK_FILTER),
    source: initialFilter?.source === 'task' ? 'all' : (initialFilter?.source ?? 'all'),
    project: 'all'
  }))
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const current = () => alive && selectConsoleAccountScope(useAppStore.getState()) === scope
    setLoading(true)
    setError('')
    void collectQueuePages(async (cursor) => {
      if (!current() || !viewer) {
        throw new Error(
          translate('workActions.viewerUnknown', 'Reopen this list to confirm your account.')
        )
      }
      const page = workflowData(
        await handoffApi().list({ view: 'archived', ...(cursor ? { cursor } : {}) })
      )
      if (
        !current() ||
        page.assignee !== viewer ||
        page.view !== 'archived' ||
        page.threads.some(
          (thread) => ![thread.author_employee_id, thread.recipient_employee_id].includes(viewer)
        )
      ) {
        throw new Error(
          translate(
            'workActions.archiveViewUnavailable',
            'This server could not confirm your archived handoffs.'
          )
        )
      }
      return page
    }, pages)
      .then((value) => {
        if (current()) {
          setQueue(value)
        }
      })
      .catch((reason) => {
        if (current()) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      })
      .finally(() => {
        if (current()) {
          setLoading(false)
        }
      })
    return () => {
      alive = false
    }
  }, [scope, viewer, revision, pages])
  const allRows = (queue?.threads ?? []).map((thread) =>
    thread.author_employee_id === viewer ? sentRow(thread) : receivedRow(thread)
  )
  const rows = filterWorkRows(allRows, filter, names)
  const row = rows.find((candidate) => candidate.key === selected)
  const refresh = () => setRevision((value) => value + 1)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BackofficeWorkFilterRow
        filter={filter}
        choices={workFilterChoices(allRows)}
        names={names}
        allControls
        includeTasks={false}
        onChange={setFilter}
      />
      <div className="flex items-center gap-2 px-3 py-2">
        <Button size="xs" variant="ghost" disabled={loading} onClick={refresh}>
          {translate('inbox.refresh', 'Refresh')}
        </Button>
        {loading ? (
          <p role="status" className="text-xs">
            {translate('workActions.loadingArchive', 'Loading archived handoffs…')}
          </p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="px-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {queue?.next_cursor ? (
        <p className="px-3 text-xs text-muted-foreground">
          {translate(
            'workActions.archivePartial',
            'Only the loaded handoffs are shown and selected.'
          )}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek">
        <BackofficeActionList
          scope={scope}
          viewer={viewer}
          rows={rows}
          names={names}
          selectedKey={selected}
          onSelect={setSelected}
          archived
          onChanged={refresh}
          emptyText={
            loading
              ? ''
              : translate('workActions.archiveEmpty', 'No archived handoffs match this view.')
          }
        />
        {queue?.next_cursor && pages < 40 ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={() => setPages((value) => value + 4)}
          >
            {translate('workActions.loadMoreHandoffs', 'Load more handoffs')}
          </Button>
        ) : null}
        {row?.thread ? (
          <div className="border-t p-3">
            <HandoffDetailView
              scope={scope}
              threadId={row.thread.id}
              viewer={viewer}
              onOpenTask={onOpenTask}
              onChanged={refresh}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
