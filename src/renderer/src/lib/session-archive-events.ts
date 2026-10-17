/**
 * One notice per archive or unarchive the window's sidebar store applies, whichever path asked
 * (a person, the CLI, a pane's agent, account sync, a handoff transfer, the steward, automatic
 * filing). Loading the list and migrating a key emit nothing: neither is a new archive.
 */

import type { ArchiveSleepVia } from '../../../shared/archive-sleep-contract'

export type ConversationArchiveVia = ArchiveSleepVia

export type ConversationArchiveEvent = {
  /** Sidebar view keys (`conversationViewKey`). */
  keys: readonly string[]
  archived: boolean
  via: ConversationArchiveVia
}

type Listener = (event: ConversationArchiveEvent) => void

const listeners = new Set<Listener>()
let executorScope: ConversationArchiveVia | null = null

/**
 * Runs a store change on behalf of one executor, so the notice it emits names who archived.
 * Why a scope: the store actions carry no executor; outside a scope the path is `unknown`, which
 * never counts as a person's archive.
 */
export function withArchiveExecutor<T>(via: ConversationArchiveVia, run: () => T): T {
  const previous = executorScope
  executorScope = via
  try {
    return run()
  } finally {
    executorScope = previous
  }
}

export function currentArchiveExecutor(): ConversationArchiveVia | null {
  return executorScope
}

export function onConversationArchiveChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitConversationArchiveChange(event: ConversationArchiveEvent): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(event)
    } catch (error) {
      // Why: a listener's failure must never undo or block the archive that already happened.
      console.warn('[session-archive-events] listener failed', error)
    }
  }
}
