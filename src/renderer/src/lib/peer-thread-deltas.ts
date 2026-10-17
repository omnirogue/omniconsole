import { isBackofficePollingIdle } from './backoffice-polling-activity'
import {
  BACKOFFICE_POLLING,
  PEER_SWEEP_INTERVAL_MS
} from '../../../shared/backoffice-polling-cadence'
import type { PeerMessageThread } from '../../../shared/peer-message-contract'
import { peerMessageProjects, peerMessageThreads } from './peer-messages'
import { BackofficeNotModified } from './backoffice-not-modified'
import { getWindowParkVisible } from './window-park-visibility'

export function peerWindowFocused(): boolean {
  return (
    !isBackofficePollingIdle() &&
    getWindowParkVisible() &&
    (typeof document === 'undefined' ||
      typeof document.hasFocus !== 'function' ||
      document.hasFocus())
  )
}

/** The single delta seam: replace the sweep here when the server summary becomes available. */
export function createPeerThreadDeltas() {
  const deepProjects = new Set<string>()
  const positions = new Map<string, { pages: number; cursor: string | null; seen: Set<string> }>()
  const requestedDepth = new Map<string, number>()
  const replayProjects = new Set<string>()
  let disposed = false
  const projects = new Map<string, PeerMessageThread[]>()
  let snapshot: PeerMessageThread[] | null = null
  let lastSweep = -Infinity
  let pending: Promise<PeerMessageThread[]> | null = null
  let morePending: Promise<PeerMessageThread[]> | null = null
  let selected: string | null = null
  let selectedAt = -Infinity
  let needsWake = false
  let sweeping = false
  let sweepError: unknown = null
  let invalidated = false

  async function projectRead(id: string, pages: number): Promise<boolean> {
    const replay = replayProjects.has(id)
    if (replay) {
      pages = Math.max(pages, requestedDepth.get(id) ?? 1)
    }
    let page
    try {
      page = await peerMessageThreads(
        id,
        undefined,
        !replay && projects.has(id) && (pages === 1 || deepProjects.has(id))
      )
    } catch (error) {
      if (error instanceof BackofficeNotModified) {
        return false
      }
      throw error
    }
    const rows = [...page.threads]
    const seen = new Set<string>()
    let readPages = 1
    for (let count = 1; count < pages && page.next_cursor; count += 1) {
      if (
        disposed ||
        (!replay && selected !== id) ||
        isBackofficePollingIdle() ||
        !getWindowParkVisible()
      ) {
        return false
      }
      if (seen.has(page.next_cursor)) {
        throw new Error('Message history repeated a page. Refresh to try again.')
      }
      seen.add(page.next_cursor)
      try {
        page = await peerMessageThreads(id, page.next_cursor)
        rows.push(...page.threads)
        readPages += 1
      } catch (error) {
        if (replay) {
          throw error
        }
        break
      }
    }
    if (pages > 1) {
      deepProjects.add(id)
    }
    // A routine newest-page sweep keeps history the person explicitly opened.
    const previous = positions.get(id)
    if (!replay && page.next_cursor && (previous?.pages ?? 0) > readPages) {
      const refreshed = new Set(rows.map((row) => row.id))
      rows.push(...(projects.get(id) ?? []).filter((row) => !refreshed.has(row.id)))
    } else {
      positions.set(id, { pages: readPages, cursor: page.next_cursor, seen })
    }
    replayProjects.delete(id)
    projects.set(id, [...new Map(rows.map((row) => [row.id, row])).values()])
    return true
  }

  async function readSelected(fresh: Set<string>): Promise<boolean> {
    const opened = selected
    if (
      !opened ||
      disposed ||
      (fresh.has(opened) && deepProjects.has(opened)) ||
      isBackofficePollingIdle() ||
      !getWindowParkVisible() ||
      Date.now() - selectedAt < BACKOFFICE_POLLING.focusedMs
    ) {
      return false
    }
    const changed = await projectRead(opened, BACKOFFICE_POLLING.peerOpenMaxPages)
    fresh.add(opened)
    if (selected === opened) {
      selectedAt = Date.now()
    }
    return changed
  }

  const reader = {
    hasMore() {
      return [...positions.values()].some((position) => position.cursor !== null)
    },
    invalidate() {
      invalidated = true
    },
    refreshSelected() {
      selectedAt = -Infinity
    },
    dispose() {
      disposed = true
    },
    select(project: string | null) {
      if (selected !== project) {
        if (project) {
          deepProjects.delete(project)
        }
        selected = project
        selectedAt = -Infinity
      }
    },
    wake() {
      if (!sweeping) {
        needsWake = true
        selectedAt = -Infinity
      }
    },
    loadMore(isCancelled: () => boolean = () => false): Promise<PeerMessageThread[]> {
      if (morePending) {
        return morePending
      }
      morePending = (async () => {
        await reader.read()
        if (disposed || isCancelled() || !peerWindowFocused()) {
          return snapshot ?? []
        }
        pending = (async () => {
          for (const [id, position] of positions) {
            if (disposed || isCancelled() || !peerWindowFocused()) {
              break
            }
            const cursor = position.cursor
            if (!cursor) {
              continue
            }
            const page = await peerMessageThreads(id, cursor)
            if (disposed) {
              break
            }
            if (
              page.next_cursor === cursor ||
              (page.next_cursor && position.seen.has(page.next_cursor))
            ) {
              throw new Error('Message history repeated a page. Refresh to try again.')
            }
            projects.set(id, [
              ...new Map(
                [...(projects.get(id) ?? []), ...page.threads].map((row) => [row.id, row])
              ).values()
            ])
            position.pages += 1
            position.seen.add(cursor)
            position.cursor = page.next_cursor
            requestedDepth.set(id, position.pages)
            snapshot = null
          }
          snapshot ??= [...projects.values()].flat()
          return snapshot
        })().finally(() => {
          pending = null
        })
        return pending
      })().finally(() => {
        morePending = null
      })
      return morePending
    },
    read(): Promise<PeerMessageThread[]> {
      if (disposed) {
        return Promise.resolve(snapshot ?? [])
      }
      if (pending) {
        return pending.then((value) =>
          invalidated ||
          (needsWake && peerWindowFocused()) ||
          (selected &&
            selectedAt === -Infinity &&
            getWindowParkVisible() &&
            !isBackofficePollingIdle())
            ? reader.read()
            : value
        )
      }
      if (invalidated) {
        invalidated = false
        needsWake = true
        selectedAt = -Infinity
        lastSweep = -Infinity
        for (const id of projects.keys()) {
          replayProjects.add(id)
        }
      }
      pending = (async () => {
        const fresh = new Set<string>()
        let changed = await readSelected(fresh)
        if (
          !disposed &&
          peerWindowFocused() &&
          (needsWake || Date.now() - lastSweep >= PEER_SWEEP_INTERVAL_MS)
        ) {
          needsWake = false
          sweepError = null
          // Claim before awaiting so repeated wake events cannot enqueue a second sweep.
          sweeping = true
          const listed = await peerMessageProjects()
          lastSweep = Date.now()
          const allowed = new Set(listed.map((project) => project.id))
          for (const id of projects.keys()) {
            if (!allowed.has(id)) {
              projects.delete(id)
              deepProjects.delete(id)
              positions.delete(id)
              requestedDepth.delete(id)
              replayProjects.delete(id)
              changed = true
            }
          }
          for (const project of listed) {
            if (disposed || !peerWindowFocused()) {
              needsWake = true
              break
            }
            // Opening preempts the sweep after its current request, without another read family.
            changed = (await readSelected(fresh)) || changed
            if (project.id !== selected && !fresh.has(project.id)) {
              changed = (await projectRead(project.id, 1)) || changed
              fresh.add(project.id)
            }
          }
        }
        if (sweepError) {
          throw sweepError
        }
        if (!snapshot || changed) {
          snapshot = [...projects.values()].flat()
        }
        return snapshot
      })()
        .catch((error) => {
          if (sweeping) {
            sweepError = error
          }
          throw error
        })
        .finally(() => {
          pending = null
          sweeping = false
        })
      return pending
    }
  }
  return reader
}
