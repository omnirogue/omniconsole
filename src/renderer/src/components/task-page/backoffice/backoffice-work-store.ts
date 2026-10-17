import { appendBackofficeMessageHistory } from './backoffice-message-history'
import { backofficeMessageHistoryPort } from './backoffice-message-history-port'
import { emptyBackofficeReads } from './backoffice-work-idle-reads'

export { emptyBackofficeReads }
import { previousOf, createWorkReadLoader } from './backoffice-work-read-loader'
import { readPeerMessages } from '@/lib/peer-messages'
import { BACKOFFICE_POLLING } from '../../../../../shared/backoffice-polling-cadence'
import { create } from 'zustand'
import { handoffApi } from '@/components/handoffs/handoff-client'
import { workflowData } from '@/lib/console-workflow-client'
import { createPeerThreadDeltas } from '@/lib/peer-thread-deltas'
import {
  toWorkViewsInput,
  type RosterEntry,
  type WorkLoad,
  type WorkReads
} from './backoffice-work-reads'
import {
  collectQueuePages,
  collectTodoPages,
  MAX_TODO_PAGES,
  readHumanActions,
  readSentPage,
  readTodoPage,
  TodoPageStale,
  type TodoFeed
} from './backoffice-work-pages'

/**
 * One scoped query layer for the Console work Tasks, the Inbox links and the Attention
 * summary read. Each read keeps its own honest state; a scope switch drops every row.
 * Active readers refresh within 60 seconds and on focus, as well as after mutations.
 */
export type { RosterEntry, TodoFeed, WorkLoad, WorkReads }
export { toWorkViewsInput }
type WorkState = WorkReads & {
  scope: string | null
  loadedAt: number | null
  /** The finished history is read only once a lens asked for it; Needs You never pays for it. */
  historyRequested: boolean
  messagesMore: boolean
  messagesLoadingMore: boolean
  messagesHistoryError: string | null
}

const FRESH_FOR_MS = BACKOFFICE_POLLING.focusedMs

export const useBackofficeWorkStore = create<WorkState>(() => ({
  scope: null,
  loadedAt: null,
  historyRequested: false,
  messagesMore: false,
  messagesLoadingMore: false,
  messagesHistoryError: null,
  ...emptyBackofficeReads()
}))

let peerThreads = createPeerThreadDeltas()
let activeLoads = 0
let queuedForce: { scope: string; promise: Promise<void> } | null = null
let generation = 0
const loadRead = createWorkReadLoader(
  (scope, gen) => gen === generation && useBackofficeWorkStore.getState().scope === scope
)
let inFlight: { scope: string; promise: Promise<void> } | null = null
// Why: a load more reads the Todo only; an unforced full load must not mistake it for its own.
let loadMoreInFlight: { scope: string; promise: Promise<void> } | null = null
/**
 * How deep the Todo walk goes for this scope. Every later read repeats the depth the person
 * asked for with load more, so a refresh never takes back the pages they opened. Capped at
 * `TODO_PAGE_CEILING` pages (ten load mores) so a runaway list cannot read forever.
 */
const TODO_PAGE_CEILING = MAX_TODO_PAGES * 10
let todoWalk: { scope: string; pages: number } | null = null

function todoPagesFor(scope: string): number {
  return todoWalk?.scope === scope ? todoWalk.pages : MAX_TODO_PAGES
}

async function readMessages(scope: string, gen: number) {
  const reader = peerThreads
  const messages = await readPeerMessages(reader)
  const live = () => gen === generation && useBackofficeWorkStore.getState().scope === scope
  if (live() && useBackofficeWorkStore.getState().messagesMore !== reader.hasMore()) {
    useBackofficeWorkStore.setState({ messagesMore: reader.hasMore() })
  }
  return messages
}

function readHistory(scope: string, gen: number): Promise<void> {
  return loadRead(scope, gen, 'receivedHistory', () =>
    collectQueuePages(async (cursor) =>
      workflowData(await handoffApi().list({ state: 'resolved', ...(cursor ? { cursor } : {}) }))
    )
  )
}

/**
 * Load every read for `scope`; concurrent unforced callers share one request per scope. The
 * finished history is read only once a caller asks for it (`history`), and from then on.
 */
export function loadBackofficeWork(
  scope: string,
  options: {
    force?: boolean
    history?: boolean
    reconcile?: boolean
    peerWake?: boolean
    peerProject?: string | null
  } = {}
): Promise<void> {
  if (
    options.force &&
    activeLoads >= BACKOFFICE_POLLING.maxConcurrentRefreshes &&
    inFlight?.scope === scope
  ) {
    if (queuedForce?.scope === scope) {
      return queuedForce.promise
    }
    const promise = inFlight.promise.then(() => {
      if (useBackofficeWorkStore.getState().scope === scope) {
        return loadBackofficeWork(scope, options)
      }
      return undefined
    })
    queuedForce = { scope, promise }
    void promise.finally(() => {
      if (queuedForce?.promise === promise) {
        queuedForce = null
      }
    })
    return promise
  }
  const state = useBackofficeWorkStore.getState()
  const history = options.history === true
  if (state.scope === scope && options.peerWake) {
    peerThreads.wake()
  }
  if (state.scope !== scope) {
    // Why: another account, organisation or environment must never see this scope's rows,
    // and the pages the person opened there are not this scope's to repeat.
    generation += 1
    peerThreads.dispose()
    peerThreads = createPeerThreadDeltas()
    inFlight = null
    loadMoreInFlight = null
    todoWalk = { scope, pages: MAX_TODO_PAGES }
    useBackofficeWorkStore.setState({
      scope,
      loadedAt: null,
      historyRequested: history,
      messagesMore: false,
      messagesLoadingMore: false,
      messagesHistoryError: null,
      ...emptyBackofficeReads()
    })
  } else if (options.force) {
    peerThreads.invalidate()
    // Why: a forced load follows a mutation; reads already in flight predate it, so drop their writes.
    generation += 1
    if (history) {
      useBackofficeWorkStore.setState({ historyRequested: true })
    }
  } else if (history && !state.historyRequested) {
    useBackofficeWorkStore.setState({ historyRequested: true })
    // Why: the other reads are fresh or in flight; the finished history is the only new read.
    if (
      inFlight?.scope === scope ||
      (state.loadedAt && Date.now() - state.loadedAt < FRESH_FOR_MS)
    ) {
      const pending = inFlight?.scope === scope ? inFlight.promise : Promise.resolve()
      return Promise.all([pending, readHistory(scope, generation)]).then(() => undefined)
    }
  } else if (inFlight?.scope === scope) {
    if (options.peerWake) {
      return Promise.all([
        inFlight.promise,
        loadRead(scope, generation, 'messages', () => readMessages(scope, generation), true)
      ]).then(() => undefined)
    }
    return inFlight.promise
  } else if (!options.reconcile && state.loadedAt && Date.now() - state.loadedAt < FRESH_FOR_MS) {
    return Promise.resolve()
  }
  // Why: a load more appending to this scope's Todo would race a fresh first-page walk; it
  // finishes first, then every feed is read (the generation guard drops its late write).
  if (loadMoreInFlight?.scope === scope && !options.force) {
    const pending = loadMoreInFlight.promise
    return pending.then(() => {
      // Why: the person may have switched account while we waited; that scope owns the store now.
      if (useBackofficeWorkStore.getState().scope !== scope) {
        return undefined
      }
      return loadBackofficeWork(scope, { ...options, force: true })
    })
  }
  if (options.peerProject !== undefined) {
    peerThreads.select(options.peerProject)
  }
  if (options.peerWake) {
    peerThreads.wake()
  }
  const gen = generation
  const includeHistory = useBackofficeWorkStore.getState().historyRequested
  const pages = todoPagesFor(scope)
  activeLoads += 1
  const promise: Promise<void> = Promise.all([
    loadRead(scope, gen, 'todo', () =>
      collectTodoPages(readTodoPage, {
        maxPages: pages,
        previous: previousOf(useBackofficeWorkStore.getState().todo)
      })
    ),
    loadRead(scope, gen, 'receivedOpen', () =>
      collectQueuePages(async (cursor) =>
        workflowData(await handoffApi().list(cursor ? { cursor } : {}))
      )
    ),
    ...(includeHistory ? [readHistory(scope, gen)] : []),
    loadRead(scope, gen, 'sent', () => collectQueuePages(readSentPage), true),
    loadRead(
      scope,
      gen,
      'roster',
      async () => workflowData(await handoffApi().recipients()).employees
    ),
    loadRead(scope, gen, 'humanActions', readHumanActions, true),
    loadRead(scope, gen, 'messages', () => readMessages(scope, gen), true)
  ]).then(() => {
    if (gen === generation) {
      useBackofficeWorkStore.setState({ loadedAt: Date.now() })
    }
  })
  inFlight = { scope, promise }
  void promise.finally(() => {
    activeLoads -= 1
    if (inFlight?.promise === promise) {
      inFlight = null
    }
  })
  return promise
}

/**
 * Append the next Todo pages to the feed already held, and remember that this scope's walk now
 * goes that deep so a later read repeats it instead of taking the pages back. Nothing is read
 * while a load or another load more for this scope is in flight; a forced reload that starts
 * meanwhile supersedes the pages appended here (their write carries the older generation); a
 * page position the server let go re-reads the list from its first page, not a dead cursor.
 */
export function loadMoreBackofficeTodo(scope: string): Promise<void> {
  const state = useBackofficeWorkStore.getState()
  const gen = generation
  const feed = state.scope === scope && state.todo.phase === 'ready' ? state.todo.value : null
  if (!feed?.nextCursor || inFlight?.scope === scope || loadMoreInFlight?.scope === scope) {
    return Promise.resolve()
  }
  let stale = false
  let appended = false
  const promise: Promise<void> = loadRead(scope, gen, 'todo', async () => {
    try {
      const deeper = await collectTodoPages(readTodoPage, { from: feed })
      appended = true
      return deeper
    } catch (error) {
      if (error instanceof TodoPageStale) {
        stale = true
        return feed
      }
      throw error
    }
  }).then(() => {
    if (useBackofficeWorkStore.getState().scope !== scope) {
      return undefined
    }
    if (stale && gen === generation) {
      return loadBackofficeWork(scope, { force: true })
    }
    if (appended) {
      todoWalk = {
        scope,
        pages: Math.min(TODO_PAGE_CEILING, todoPagesFor(scope) + MAX_TODO_PAGES)
      }
    }
    return undefined
  })
  loadMoreInFlight = { scope, promise }
  void promise.finally(() => {
    if (loadMoreInFlight?.promise === promise) {
      loadMoreInFlight = null
    }
  })
  return promise
}

/** Re-read the current scope after a mutation (complete, archive, send, review, return). */
export function invalidateBackofficeWork(): void {
  const { scope } = useBackofficeWorkStore.getState()
  if (scope) {
    void loadBackofficeWork(scope, { force: true })
  }
}

export { useBackofficeWorkViews } from './backoffice-work-views-hook'

/** Selection is a user action; it reads only the peer family and shares any pending sweep. */
export async function selectBackofficePeerProject(
  scope: string,
  project: string | null
): Promise<void> {
  if (useBackofficeWorkStore.getState().scope !== scope) {
    return
  }
  peerThreads.select(project)
  if (project) {
    const gen = generation
    await loadRead(scope, gen, 'messages', () => readMessages(scope, gen), true)
  }
}

export function loadMoreBackofficeMessages(
  scope: string,
  isCancelled?: () => boolean
): Promise<void> {
  const gen = generation
  const reader = peerThreads
  const attached = () => reader === peerThreads && useBackofficeWorkStore.getState().scope === scope
  return appendBackofficeMessageHistory(
    backofficeMessageHistoryPort(useBackofficeWorkStore),
    scope,
    reader,
    () => attached() && gen === generation,
    attached,
    isCancelled
  )
}
