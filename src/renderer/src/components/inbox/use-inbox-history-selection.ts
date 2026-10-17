import { useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { useAppStore } from '@/store'
import {
  loadMoreBackofficeMessages,
  useBackofficeWorkStore
} from '@/components/task-page/backoffice/backoffice-work-store'
import { valueOf } from '@/components/task-page/backoffice/backoffice-work-reads'
import {
  canSelectWorkRow,
  type BulkWorkResult
} from '@/components/task-page/backoffice/backoffice-bulk-actions'
import {
  filterWorkRows,
  type WorkFilter
} from '@/components/task-page/backoffice/backoffice-work-labels'
import { messageRow } from '../../../../shared/backoffice-work-message-rows'
import type { WorkRow } from '../../../../shared/backoffice-work-views'
import { enumerateInboxHandoffs, type InboxHandoffEnumeration } from './inbox-matching-handoffs'

const MAX_MESSAGE_ROUNDS = 60

export function useInboxHistorySelection({
  scope,
  viewer,
  kind,
  rows,
  names,
  filter,
  unreadOnly,
  isUnread
}: {
  scope: string
  viewer: string | null
  kind: 'messages' | 'handoffs'
  rows: WorkRow[]
  names: ReadonlyMap<string, string>
  filter: WorkFilter
  unreadOnly: boolean
  isUnread: (row: WorkRow) => boolean
}) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [extraRows, setExtraRows] = useState<WorkRow[]>([])
  const [selectionRequest, setSelectionRequest] = useState<string[]>()
  const alive = useRef(true)
  const cancelled = useRef(false)
  const running = useRef(false)
  const handoffHistory = useRef<InboxHandoffEnumeration | undefined>(undefined)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      cancelled.current = true
    }
  }, [])
  const current = () => alive.current && selectConsoleAccountScope(useAppStore.getState()) === scope

  const selectAll = async () => {
    if (!viewer || running.current || !current()) {
      return
    }
    running.current = true
    cancelled.current = false
    setBusy(true)
    setNotice('')
    let loaded = rows
    let complete = false
    let reason = ''
    let limit = ''
    try {
      if (kind === 'handoffs') {
        const result = await enumerateInboxHandoffs({
          viewer,
          isCurrent: current,
          isCancelled: () => cancelled.current,
          from: handoffHistory.current
        })
        handoffHistory.current = result
        loaded = result.complete
          ? result.rows
          : [...new Map([...rows, ...result.rows].map((row) => [row.key, row])).values()]
        complete = result.complete
        reason = result.errors.join(' ')
        if (result.stopped === 'limit') {
          limit = translate(
            'inbox.handoffSelectionLimit',
            'Loading stopped after 60 more pages. Select all matching again to continue.'
          )
        }
      } else {
        let state = useBackofficeWorkStore.getState()
        if (state.scope !== scope) {
          return
        }
        for (let round = 0; round < MAX_MESSAGE_ROUNDS && state.messagesMore; round += 1) {
          if (cancelled.current || !current()) {
            break
          }
          const before = valueOf(state.messages)
          await loadMoreBackofficeMessages(scope, () => cancelled.current || !current())
          state = useBackofficeWorkStore.getState()
          if (state.scope !== scope) {
            return
          }
          if (state.messagesHistoryError) {
            reason = state.messagesHistoryError
            break
          }
          if (before === valueOf(state.messages) && state.messagesMore) {
            if (!cancelled.current) {
              reason = translate(
                'inbox.historyPaused',
                'History loading paused. Keep the Inbox open and try again.'
              )
            }
            break
          }
        }
        loaded = valueOf(state.messages)?.map((message) => messageRow(message, viewer)) ?? rows
        complete = state.messages.phase === 'ready' && !state.messagesMore && !reason
        if (state.messages.phase !== 'ready' && !reason) {
          reason = translate(
            'inbox.historyUnavailable',
            'Message history is unavailable. Refresh to try again.'
          )
        }
        if (!complete && !reason) {
          limit = translate(
            'inbox.messageSelectionLimit',
            'Loading stopped after up to 60 older pages per project. Select all matching again to continue.'
          )
        }
      }
      if (!current()) {
        return
      }
      const matching = filterWorkRows(loaded, filter, names).filter(
        (row) => (!unreadOnly || isUnread(row)) && canSelectWorkRow(row, viewer)
      )
      setExtraRows(kind === 'handoffs' ? loaded : [])
      setSelectionRequest(matching.map((row) => row.key))
      const selection =
        complete && !cancelled.current
          ? translate('inbox.selectedAllMatching', 'Selected all {{count}} matching items.', {
              count: matching.length
            })
          : translate(
              'inbox.selectedLoadedMatching',
              'Selected {{count}} matching items from loaded history. More history may remain.',
              { count: matching.length }
            )
      const stopped = cancelled.current
        ? translate('inbox.selectionCancelled', 'Loading cancelled.')
        : !complete && !reason
          ? limit
          : reason
      setNotice([selection, stopped].filter(Boolean).join(' '))
    } catch (error) {
      if (current()) {
        setNotice(error instanceof Error ? error.message : String(error))
      }
    } finally {
      running.current = false
      if (current()) {
        setBusy(false)
      }
    }
  }

  const onActionResults = (results: BulkWorkResult[]) => {
    const done = new Set(results.filter((result) => result.ok).map((result) => result.key))
    if (handoffHistory.current) {
      handoffHistory.current = {
        ...handoffHistory.current,
        rows: handoffHistory.current.rows.filter((row) => !done.has(row.key))
      }
    }
    setExtraRows((previous) => previous.filter((row) => !done.has(row.key)))
    setNotice('')
  }
  return {
    busy,
    notice,
    extraRows,
    selectionRequest,
    selectAll,
    cancel: () => {
      cancelled.current = true
    },
    onActionResults
  }
}
