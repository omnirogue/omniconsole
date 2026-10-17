import { BACKOFFICE_POLLING } from '../../../shared/backoffice-polling-cadence'
import { installWindowVisibilityTimeoutPoller } from './window-visibility-timeout-poller'
import { getWindowParkVisible, subscribeWindowParkVisibility } from './window-park-visibility'

export type SessionDataIssue = 'signed-out' | 'unavailable'
export type SessionDataStatus = 'loading' | 'healthy' | 'healthy-empty' | SessionDataIssue | 'stale'

export type SessionDataSnapshot<T> = {
  data: T
  status: SessionDataStatus
  issue: SessionDataIssue | null
  error: string | null
  lastSuccessAt: number | null
  readAt: number
}

export type SessionDataRead<T> = { data?: T; issue?: SessionDataIssue; error?: string }

export function sessionDataFailure(error: unknown): { issue: SessionDataIssue; error: string } {
  const code = (error as { code?: string } | null)?.code
  return {
    issue: code === 'unauthorized' || code === 'signed-out' ? 'signed-out' : 'unavailable',
    error: error instanceof Error ? error.message : String(error)
  }
}

/** One snapshot and serial poll for every visible reader of an addressed queue. */
export function createSessionDataSnapshotStore<T>(options: {
  initial: T
  intervalMs: number
  read: (previous: T) => Promise<SessionDataRead<T>>
  empty: (data: T) => boolean
  current?: () => boolean
}) {
  let snapshot: SessionDataSnapshot<T> = {
    data: options.initial,
    status: 'loading',
    issue: null,
    error: null,
    lastSuccessAt: null,
    readAt: 0
  }
  const subscribers = new Set<{ listener: () => void; visible: boolean }>()
  let visibleReaders = 0
  let stopPoll: (() => void) | null = null
  let inFlight: Promise<void> | null = null
  let revision = 0
  let readAgain = false
  let writes: Promise<unknown> = Promise.resolve()
  let pendingWrites = 0
  const current = () => options.current?.() !== false
  const emit = () => subscribers.forEach(({ listener }) => listener())

  const accept = (data: T): void => {
    snapshot = {
      data,
      status: options.empty(data) ? 'healthy-empty' : 'healthy',
      issue: null,
      error: null,
      lastSuccessAt: Date.now(),
      readAt: Date.now()
    }
    emit()
  }

  const fail = (result: SessionDataRead<T>): void => {
    const issue = result.issue ?? 'unavailable'
    snapshot = {
      ...snapshot,
      data: snapshot.lastSuccessAt !== null ? snapshot.data : (result.data ?? snapshot.data),
      status: snapshot.lastSuccessAt !== null ? 'stale' : issue,
      issue,
      error: result.error ?? issue,
      readAt: Date.now()
    }
    emit()
  }

  function refresh(): Promise<void> {
    if (pendingWrites > 0) {
      return writes.catch(() => {}).then(() => refresh())
    }
    if (inFlight) {
      return inFlight
    }
    if (!current()) {
      return Promise.resolve()
    }
    const requestedRevision = revision
    inFlight = Promise.resolve()
      .then(() => options.read(snapshot.data))
      .then((result) => {
        if (!current() || revision !== requestedRevision) {
          return
        }
        if (result.issue) {
          fail(result)
        } else if (result.data !== undefined) {
          accept(result.data)
        } else {
          fail({ error: 'No snapshot returned' })
        }
      })
      .catch((error: unknown) => {
        if (current() && revision === requestedRevision) {
          fail(sessionDataFailure(error))
        }
      })
      .finally(() => {
        inFlight = null
        if (readAgain && current()) {
          readAgain = false
          return refresh()
        }
        readAgain = false
        return undefined
      })
    return inFlight
  }

  function invalidate(): void {
    revision += 1
    if (inFlight) {
      readAgain = true
    } else {
      void refresh()
    }
  }

  function update(change: (data: T) => T): void {
    revision += 1
    const data = change(snapshot.data)
    snapshot = {
      ...snapshot,
      data,
      status:
        snapshot.status === 'healthy' || snapshot.status === 'healthy-empty'
          ? options.empty(data)
            ? 'healthy-empty'
            : 'healthy'
          : snapshot.status
    }
    emit()
    if (inFlight) {
      readAgain = true
    }
  }

  function mutate(write: (previous: T) => Promise<T>): Promise<T> {
    pendingWrites += 1
    revision += 1
    const result = writes
      .catch(() => {})
      .then(async () => {
        if (!current()) {
          throw new Error('The queue account or runtime changed')
        }
        revision += 1
        try {
          const data = await write(snapshot.data)
          if (current()) {
            revision += 1
            accept(data)
          }
          return data
        } catch (error) {
          if (current()) {
            revision += 1
            fail(sessionDataFailure(error))
          }
          throw error
        }
      })
      .finally(() => {
        pendingWrites -= 1
      })
    writes = result
    return result
  }

  function startPoll(): void {
    stopPoll = installWindowVisibilityTimeoutPoller({
      run: refresh,
      runOnStart: getWindowParkVisible(),
      canRun: () => visibleReaders > 0,
      getDelayMs: () => (getWindowParkVisible() ? options.intervalMs : BACKOFFICE_POLLING.hiddenMs),
      subscribeWake(wake, reschedule) {
        const visibility = () => (getWindowParkVisible() ? wake() : reschedule())
        const focus = () => {
          if (getWindowParkVisible()) {
            wake()
          }
        }
        const stopVisibility = subscribeWindowParkVisibility(visibility)
        window.addEventListener('focus', focus)
        return () => {
          stopVisibility()
          window.removeEventListener('focus', focus)
        }
      }
    })
  }

  function subscribe(listener: () => void, visible = true): () => void {
    const subscriber = { listener, visible }
    subscribers.add(subscriber)
    if (visible && ++visibleReaders === 1) {
      startPoll()
    }
    return () => {
      if (!subscribers.delete(subscriber)) {
        return
      }
      if (visible && --visibleReaders === 0) {
        stopPoll?.()
        stopPoll = null
      }
    }
  }

  return { getSnapshot: () => snapshot, subscribe, refresh, invalidate, update, mutate }
}

export type SessionDataSnapshotStore<T> = ReturnType<typeof createSessionDataSnapshotStore<T>>
