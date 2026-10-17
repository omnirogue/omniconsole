import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { InboxNewMessage } from './InboxNewMessage'
import { useInboxReadState } from './inbox-read-state'
import { Button } from '@/components/ui/button'
import { HandoffDetailView } from '@/components/handoffs/HandoffDetailView'
import { translate as t } from '@/i18n/i18n'
import { InboxDeletedMessages } from './InboxDeletedMessages'
import { BackofficeActionList } from '@/components/task-page/backoffice/BackofficeActionList'
import { BackofficeArchivedHandoffs } from '@/components/task-page/backoffice/BackofficeArchivedHandoffs'
import { BackofficeWorkMessageDetail } from '@/components/task-page/backoffice/backoffice-work-message-detail'
import {
  loadMoreBackofficeMessages,
  useBackofficeWorkStore,
  useBackofficeWorkViews
} from '@/components/task-page/backoffice/backoffice-work-store'
import { useInboxHistorySelection } from './use-inbox-history-selection'
import { valueOf } from '@/components/task-page/backoffice/backoffice-work-reads'
import { BackofficeWorkFilterRow } from '@/components/task-page/backoffice/backoffice-work-filter-row'
import {
  EMPTY_WORK_FILTER,
  filterWorkRows,
  workFilterChoices,
  workEmptyText,
  describeWorkGap
} from '@/components/task-page/backoffice/backoffice-work-labels'

type InboxRequestsProps = {
  scope: string
  kind: 'messages' | 'handoffs'
  onOpenTask: (id: string) => void
}

/** Inbox and Work project the same received/sent records and use the same detail controls. */
export function InboxRequests(props: InboxRequestsProps) {
  return <ScopedInboxRequests key={`${props.scope}:${props.kind}`} {...props} />
}

function ScopedInboxRequests({ scope, kind, onOpenTask }: InboxRequestsProps) {
  const { views, reads, names, loading, refresh } = useBackofficeWorkViews(scope, true, undefined, {
    history: true
  })
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState(EMPTY_WORK_FILTER)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const baseRequests = views.all.filter((row) =>
    kind === 'messages' ? !!row.message : !!row.thread
  )
  const todo = valueOf(reads.todo)
  const viewer =
    todo?.employeeId ??
    valueOf(reads.receivedOpen)?.assignee ??
    valueOf(reads.sent)?.assignee ??
    null
  const readState = useInboxReadState(scope, viewer)
  const history = useInboxHistorySelection({
    scope,
    viewer,
    kind,
    rows: baseRequests,
    names,
    filter,
    unreadOnly,
    isUnread: readState.isUnread
  })
  const messageHistory = useBackofficeWorkStore(
    useShallow((state) => ({
      more: state.scope === scope && state.messagesMore,
      loading: state.scope === scope && state.messagesLoadingMore,
      error: state.scope === scope ? state.messagesHistoryError : null
    }))
  )
  const requests = [
    ...new Map([...history.extraRows, ...baseRequests].map((row) => [row.key, row])).values()
  ]
  const filtered = filterWorkRows(requests, filter, names)
  const rows = filtered.filter((item) => !unreadOnly || readState.isUnread(item))
  const row = filtered.find((item) => item.key === selected)
  const listProps = {
    rows,
    selectionRequest: history.selectionRequest,
    selectionPending: history.busy,
    onActionResults: history.onActionResults,
    selectedKey: selected,
    names,
    emptyText: workEmptyText('all', views.gaps, rows.length < requests.length),
    onSelect: (key: string) => {
      const item = requests.find((request) => request.key === key)
      if (item) {
        readState.markRead(item)
      }
      setSelected(key)
    },
    readState
  }
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b p-3">
        <Button size="sm" variant="ghost" disabled={history.busy} onClick={refresh}>
          {t('inbox.refresh', 'Refresh')}
        </Button>
        {kind === 'messages' && <InboxNewMessage key={scope} onSent={refresh} />}
        <Button
          size="sm"
          variant={unreadOnly ? 'secondary' : 'ghost'}
          aria-pressed={unreadOnly}
          disabled={history.busy}
          onClick={() => setUnreadOnly((value) => !value)}
        >
          {t('inbox.unreadOnly', 'Unread')}
        </Button>
        {loading && (
          <p role="status" className="text-xs">
            {t('inbox.loading', 'Loading conversations…')}
          </p>
        )}
      </div>
      <fieldset disabled={history.busy}>
        <BackofficeWorkFilterRow
          filter={filter}
          choices={workFilterChoices(requests)}
          names={names}
          allControls
          includeTasks={false}
          onChange={setFilter}
        />
      </fieldset>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <p className="text-xs text-muted-foreground">
          {t('inbox.loadedMessageCount', '{{visible}} visible of {{loaded}} loaded', {
            visible: rows.length,
            loaded: requests.length
          })}
        </p>
        <Button
          size="xs"
          variant="outline"
          disabled={loading || !viewer || history.busy || messageHistory.loading}
          onClick={() => void history.selectAll()}
        >
          {t('inbox.selectAllMatching', 'Select all matching')}
        </Button>
        {history.busy ? (
          <>
            <p role="status" className="text-xs">
              {t('inbox.loadingMatching', 'Loading matching history…')}
            </p>
            <Button size="xs" variant="ghost" onClick={history.cancel}>
              {t('inbox.cancelHistory', 'Cancel loading')}
            </Button>
          </>
        ) : null}
      </div>
      {history.notice ? (
        <p role="status" className="px-3 py-2 text-xs">
          {history.notice}
        </p>
      ) : null}
      {views.gaps.map((gap) => (
        <p key={gap} role="alert" className="px-3 py-1 text-xs text-destructive">
          {describeWorkGap(gap)}
        </p>
      ))}
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto scrollbar-sleek md:grid-cols-2">
        <div className="min-w-0">
          {kind === 'handoffs' ? (
            <BackofficeActionList
              key={scope}
              scope={scope}
              viewer={viewer}
              removalLabel="delete"
              {...listProps}
              toolbar={
                <BackofficeArchivedHandoffs
                  scope={scope}
                  viewer={viewer}
                  names={names}
                  filter={filter}
                  onOpenTask={onOpenTask}
                  deleted
                />
              }
            />
          ) : (
            <BackofficeActionList
              scope={scope}
              viewer={viewer}
              removalLabel="delete"
              {...listProps}
              toolbar={
                <InboxDeletedMessages
                  scope={scope}
                  viewer={viewer}
                  names={names}
                  baseUrl={todo?.baseUrl ?? null}
                  onOpenTask={onOpenTask}
                />
              }
            />
          )}
          {kind === 'messages' && messageHistory.more ? (
            <div className="border-t p-3">
              <p className="mb-2 text-xs text-muted-foreground">
                {t(
                  'inbox.moreMessagesAvailable',
                  'Older messages are available. Select all visible applies only to the loaded rows matching your filters.'
                )}
              </p>
              <Button
                size="sm"
                variant="ghost"
                disabled={messageHistory.loading || history.busy}
                onClick={() => void loadMoreBackofficeMessages(scope)}
              >
                {messageHistory.loading
                  ? t('inbox.loadingMoreMessages', 'Loading older messages…')
                  : t('inbox.loadMoreMessages', 'Load more messages')}
              </Button>
            </div>
          ) : null}
          {kind === 'messages' && messageHistory.error ? (
            <p role="alert" className="p-3 text-xs text-destructive">
              {messageHistory.error}
            </p>
          ) : null}
        </div>
        <div className="min-w-0 overflow-auto scrollbar-sleek border-l p-3">
          {row?.message ? (
            <BackofficeWorkMessageDetail
              key={row.key}
              row={row}
              message={row.message}
              names={names}
              baseUrl={todo?.baseUrl ?? null}
              viewer={viewer}
              onOpenTask={onOpenTask}
              onChanged={refresh}
            />
          ) : null}
          {row?.thread ? (
            <HandoffDetailView
              key={row.key}
              scope={scope}
              threadId={row.thread.id}
              viewer={viewer}
              onOpenTask={onOpenTask}
              onChanged={refresh}
            />
          ) : null}
        </div>
      </div>
    </section>
  )
}
