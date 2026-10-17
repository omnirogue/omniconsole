import { BackofficeNotModified } from '@/lib/backoffice-not-modified'
import { handoffApi } from '@/components/handoffs/handoff-client'
import {
  WorkflowRequestError,
  consoleWorkflowApi,
  workflowData
} from '@/lib/console-workflow-client'
import type { BackofficeTodoResult } from '../../../../../shared/backoffice-work-types'
import type { HandoffQueue } from '../../../../../shared/console-handoff-contract'
import type { ConsoleWorkflowJob } from '../../../../../shared/console-workflow-types'

/**
 * The paged reads behind the work store: the hub's keyset handoff queues and the BFF's
 * Todo pages, each followed for a bounded number of pages with an honest remainder.
 */
export type TodoFeed = Extract<BackofficeTodoResult, { ok: true }>

/** A 2xx that is not the read asked for: a hub that predates `view=sent` answers its received queue. */
class UnservedRead extends Error {}

// Why: codes that name the refused view or query value (the hub's own, the console read table's tag).
const REFUSED_VIEW_CODES: ReadonlySet<string> = new Set(['invalid_view', 'hub-read-invalid'])

/**
 * "Not offered" rather than failed: a route the server lacks (404/405), a refusal naming the
 * view or query value it does not accept, a 2xx that ignored the view, or an API this build of
 * the desktop does not carry. Any other 400/422 comes from a server that serves the view, so
 * it is a real refusal.
 */
export function isUnservedRead(error: unknown): boolean {
  if (error instanceof UnservedRead) {
    return true
  }
  if (!(error instanceof WorkflowRequestError)) {
    return false
  }
  const { status, code } = error.detail
  return (
    code === 'capability_unavailable' ||
    status === 404 ||
    status === 405 ||
    ((status === 400 || status === 422) && REFUSED_VIEW_CODES.has(code))
  )
}

/** The workflow stages assigned to this person (the only person-scoped job read the console has). */
export async function readHumanActions(): Promise<ConsoleWorkflowJob[]> {
  return workflowData(await consoleWorkflowApi().listHumanActions()).jobs
}

const MAX_QUEUE_PAGES = 4

/**
 * Follow the hub's keyset cursor for a bounded number of pages. Whatever is left is
 * kept as `next_cursor`, so the views say "first pages only" instead of implying all.
 */
export async function collectQueuePages(
  read: (cursor: string | undefined) => Promise<HandoffQueue>,
  maxPages = MAX_QUEUE_PAGES
): Promise<HandoffQueue> {
  let page = await read(undefined)
  const threads = [...page.threads]
  const seen = new Set(threads.map((thread) => thread.id))
  for (let count = 1; count < maxPages && page.next_cursor; count += 1) {
    const cursor = page.next_cursor
    try {
      page = await read(cursor)
    } catch {
      // Why: a later page failing leaves the earlier pages true; report the rest as unread.
      return { ...page, threads, next_cursor: cursor }
    }
    for (const thread of page.threads) {
      if (!seen.has(thread.id)) {
        seen.add(thread.id)
        threads.push(thread)
      }
    }
  }
  return { ...page, threads, next_cursor: page.next_cursor ?? null }
}

/** Pages one walk reads, and the depth a load more adds to the walk the next read repeats. */
export const MAX_TODO_PAGES = 4

/** A Todo page position the console no longer holds (HTTP 410); the walk restarts from its first page. */
export class TodoPageStale extends Error {}

/** One Todo page; the first when no cursor is given. A refusal is an error like any other read. */
export async function readTodoPage(cursor: string | undefined): Promise<TodoFeed> {
  const api = window.api.backoffice
  const result = await (cursor ? api.listTodo({ cursor }) : api.listTodo())
  if (!result.ok) {
    throw result.stale ? new TodoPageStale(result.message) : new Error(result.message)
  }
  return result
}

/**
 * Follow the BFF's Todo cursor for a bounded number of pages, or continue from a feed already
 * held (`from`). A later page failing keeps the earlier pages and the cursor it failed on, so
 * the views say "load more" instead of implying the list is whole. A page position the server
 * let go restarts a fresh walk once from its first page; a second such answer ends the walk
 * with the list marked short and no cursor to retry. A continued walk (`from`) reports a stale
 * position to its caller, whose feed it belongs to. A card lists once.
 */
export async function collectTodoPages(
  read: (cursor: string | undefined) => Promise<TodoFeed>,
  options: { from?: TodoFeed; maxPages?: number; previous?: TodoFeed | null } = {}
): Promise<TodoFeed> {
  const maxPages = options.maxPages ?? MAX_TODO_PAGES
  let first = options.from ?? (await read(undefined))
  if (first.notModified && options.previous && !options.from) {
    throw new BackofficeNotModified()
  }
  let items = [...first.items]
  let seen = new Set(items.map((item) => item.task_id))
  let awaitingVerification = first.awaitingVerification
  let nextCursor = first.nextCursor
  let count = options.from ? 0 : 1
  let restarted = false
  let staleTwice = false
  while (count < maxPages && nextCursor) {
    let page: TodoFeed
    try {
      page = await read(nextCursor)
    } catch (error) {
      if (!(error instanceof TodoPageStale)) {
        break
      }
      if (options.from) {
        throw error
      }
      if (restarted) {
        staleTwice = true
        nextCursor = null
        break
      }
      restarted = true
      first = await read(undefined)
      items = [...first.items]
      seen = new Set(items.map((item) => item.task_id))
      awaitingVerification = first.awaitingVerification
      nextCursor = first.nextCursor
      count = 1
      continue
    }
    for (const item of page.items) {
      if (!seen.has(item.task_id)) {
        seen.add(item.task_id)
        items.push(item)
      }
    }
    awaitingVerification ??= page.awaitingVerification
    nextCursor = page.nextCursor
    count += 1
  }
  return {
    ...first,
    items,
    awaitingVerification,
    nextCursor,
    // Why: a paging server says whether a page follows; only an older, capped one is judged by its total.
    truncated: staleTwice || nextCursor !== null || (first.nextCursor === null && first.truncated)
  }
}

/** One page of the reader's own sent requests; without the `view` echo the hub ignored the word. */
export async function readSentPage(cursor: string | undefined): Promise<HandoffQueue> {
  const page = workflowData(
    await handoffApi().list({ view: 'sent', ...(cursor ? { cursor } : {}) })
  )
  if (page.view !== 'sent') {
    throw new UnservedRead('This server does not provide the requests you sent.')
  }
  return page
}
