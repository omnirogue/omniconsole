import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { BackofficeActionList } from '@/components/task-page/backoffice/BackofficeActionList'
import { BackofficeWorkMessageDetail } from '@/components/task-page/backoffice/backoffice-work-message-detail'
import { BackofficeWorkFilterRow } from '@/components/task-page/backoffice/backoffice-work-filter-row'
import {
  EMPTY_WORK_FILTER,
  filterWorkRows,
  workFilterChoices
} from '@/components/task-page/backoffice/backoffice-work-labels'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { useAppStore } from '@/store'
import { translate as t } from '@/i18n/i18n'
import { messageRow } from '../../../../shared/backoffice-work-message-rows'
import { readDeletedMessages } from './inbox-deleted-messages'

type Props = {
  scope: string
  viewer: string | null
  names: ReadonlyMap<string, string>
  baseUrl: string | null
  onOpenTask: (id: string) => void
}

export function InboxDeletedMessages(props: Props) {
  const [open, setOpen] = useState(false)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button size="xs" variant="ghost" disabled={!props.viewer} onClick={() => setOpen(true)}>
        {t('inbox.deletedMessages', 'Deleted messages')}
      </Button>
      <SheetContent className="w-full sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>{t('inbox.deletedMessages', 'Deleted messages')}</SheetTitle>
          <SheetDescription>
            {t(
              'inbox.deletedExplanation',
              'Deleted from your inbox. Restore a message to bring it back.'
            )}
          </SheetDescription>
        </SheetHeader>
        {open ? <DeletedMessageList key={`${props.scope}:${props.viewer}`} {...props} /> : null}
      </SheetContent>
    </Sheet>
  )
}

function DeletedMessageList({ scope, viewer, names, baseUrl, onOpenTask }: Props) {
  const [data, setData] = useState<Awaited<ReturnType<typeof readDeletedMessages>> | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [pages, setPages] = useState(1)
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState(EMPTY_WORK_FILTER)
  const refresh = () => setRevision((value) => value + 1)
  useEffect(() => {
    let alive = true
    const current = () => alive && selectConsoleAccountScope(useAppStore.getState()) === scope
    setLoading(true)
    setError('')
    if (!viewer) {
      setLoading(false)
      return
    }
    void readDeletedMessages(viewer, pages, current)
      .then((value) => {
        if (current()) {
          setData(value)
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
  }, [scope, viewer, pages, revision])
  const allRows = (data?.messages ?? []).map((message) => messageRow(message, viewer))
  const rows = filterWorkRows(allRows, filter, names)
  const row = rows.find((item) => item.key === selected)
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
      <div className="flex items-center gap-2 p-2">
        <Button size="xs" variant="ghost" disabled={loading} onClick={refresh}>
          {t('inbox.refresh', 'Refresh')}
        </Button>
        {loading ? (
          <p role="status" className="text-xs">
            {t('inbox.loadingDeleted', 'Loading deleted messages…')}
          </p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="p-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek">
        <BackofficeActionList
          scope={scope}
          viewer={viewer}
          archived
          removalLabel="delete"
          rows={rows}
          selectedKey={selected}
          names={names}
          emptyText={t('inbox.noDeletedMessages', 'No deleted messages.')}
          onSelect={setSelected}
          onChanged={refresh}
        />
        {data?.more ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={() => setPages((value) => value + 1)}
          >
            {t('inbox.loadMoreDeleted', 'Load more deleted messages')}
          </Button>
        ) : null}
        {row?.message ? (
          <div className="border-t p-3">
            <BackofficeWorkMessageDetail
              key={row.key}
              row={row}
              message={row.message}
              names={names}
              viewer={viewer}
              baseUrl={baseUrl}
              onOpenTask={onOpenTask}
              onChanged={refresh}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
