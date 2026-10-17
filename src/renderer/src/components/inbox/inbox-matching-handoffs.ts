import { handoffApi } from '@/components/handoffs/handoff-client'
import { workflowData } from '@/lib/console-workflow-client'
import { translate } from '@/i18n/i18n'
import { receivedRow, sentRow } from '../../../../shared/backoffice-work-rows'
import type { WorkRow } from '../../../../shared/backoffice-work-views'
import type { ConsoleHandoffApi } from '../../../../shared/console-handoff-contract'

export type InboxHandoffEnumeration = {
  viewer: string
  rows: WorkRow[]
  complete: boolean
  stopped: 'cancelled' | 'limit' | 'unavailable' | null
  errors: string[]
  pagesRead: number
  continuation: {
    args: Source['args']
    cursor?: string
    seen: string[]
  }[]
}
type Source = {
  args: NonNullable<Parameters<ConsoleHandoffApi['list']>[0]>
  done: boolean
  cursor?: string
  seen: Set<string>
  failed?: boolean
}

/** Enumerate a personal selection snapshot; reading does not acknowledge or delete a thread. */
export async function enumerateInboxHandoffs(options: {
  viewer: string
  isCurrent: () => boolean
  isCancelled?: () => boolean
  maxPages?: number
  from?: InboxHandoffEnumeration
  onProgress?: (result: InboxHandoffEnumeration) => void
}): Promise<InboxHandoffEnumeration> {
  const previous = options.from?.complete === false ? options.from : undefined
  if (
    previous &&
    (previous.viewer !== options.viewer ||
      previous.rows.some(
        (row) =>
          !row.thread ||
          ![row.thread.author_employee_id, row.thread.recipient_employee_id].includes(
            options.viewer
          )
      ))
  ) {
    throw new Error(
      translate('workActions.accountChanged', 'Your account changed. Reopen this list to continue.')
    )
  }
  const sources: Source[] = previous
    ? previous.continuation.map((source) => ({
        ...source,
        done: false,
        seen: new Set(source.seen)
      }))
    : [{}, { state: 'resolved' as const }, { view: 'sent' as const }].map((args) => ({
        args,
        done: false,
        seen: new Set<string>()
      }))
  const rows = new Map<string, WorkRow>((previous?.rows ?? []).map((row) => [row.key, row]))
  const errors: string[] = []
  const maxPages = options.maxPages ?? 60
  let pagesRead = previous?.pagesRead ?? 0
  let requested = 0
  let stopped: InboxHandoffEnumeration['stopped'] = null
  const snapshot = (): InboxHandoffEnumeration => ({
    viewer: options.viewer,
    rows: [...rows.values()],
    complete: stopped === null && sources.every((source) => source.done),
    stopped,
    errors: [...errors],
    pagesRead,
    continuation: sources
      .filter((source) => !source.done || source.failed)
      .map((source) => ({
        args: source.args,
        ...(source.cursor ? { cursor: source.cursor } : {}),
        seen: [...source.seen]
      }))
  })
  const current = () => {
    if (!options.isCurrent()) {
      throw new Error(
        translate(
          'workActions.accountChanged',
          'Your account changed. Reopen this list to continue.'
        )
      )
    }
    if (options.isCancelled?.()) {
      stopped = 'cancelled'
      return false
    }
    return true
  }
  if (!current()) {
    return snapshot()
  }
  while (sources.some((source) => !source.done)) {
    for (const source of sources) {
      if (!current()) {
        return snapshot()
      }
      if (source.done) {
        continue
      }
      if (requested >= maxPages) {
        stopped = 'limit'
        return snapshot()
      }
      try {
        requested += 1
        const page = workflowData(
          await handoffApi().list({
            ...source.args,
            ...(source.cursor ? { cursor: source.cursor } : {})
          })
        )
        if (!current()) {
          return snapshot()
        }
        pagesRead += 1
        if (
          page.assignee !== options.viewer ||
          (source.args.view === 'sent' && page.view !== 'sent') ||
          (source.args.view !== 'sent' && (page.view === 'sent' || page.view === 'archived')) ||
          page.threads.some(
            (thread) =>
              thread.archived === true ||
              (source.args.state === 'resolved' && thread.state !== 'resolved') ||
              (source.args.view === 'sent'
                ? thread.author_employee_id !== options.viewer
                : thread.recipient_employee_id !== options.viewer)
          )
        ) {
          throw new Error(
            translate(
              'inbox.handoffSelectionUnconfirmed',
              'This server could not confirm your handoff selection.'
            )
          )
        }
        for (const thread of page.threads) {
          const row =
            thread.author_employee_id === options.viewer ? sentRow(thread) : receivedRow(thread)
          rows.set(row.key, row)
        }
        if (page.next_cursor === undefined) {
          throw new Error(
            translate(
              'inbox.handoffHistoryUnknown',
              'The server did not confirm whether more handoffs exist. Only the loaded handoffs can be selected.'
            )
          )
        }
        source.done = page.next_cursor === null
        if (page.next_cursor) {
          if (source.seen.has(page.next_cursor)) {
            throw new Error(
              translate(
                'inbox.handoffHistoryRepeated',
                'The server repeated a history page. Only the loaded handoffs can be selected.'
              )
            )
          }
          source.seen.add(page.next_cursor)
          source.cursor = page.next_cursor
        }
      } catch (error) {
        if (!current()) {
          return snapshot()
        }
        source.done = true
        source.failed = true
        stopped = 'unavailable'
        errors.push(error instanceof Error ? error.message : String(error))
      }
      options.onProgress?.(snapshot())
    }
  }
  return snapshot()
}
