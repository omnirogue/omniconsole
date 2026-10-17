const undoBypassByPane = new Map<string, string>()
const epochByPane = new Map<string, number>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** One-shot: the restored Undo text may be sent to the agent once. */
export function armSessionPrepUndoBypass(paneKey: string, text: string): void {
  undoBypassByPane.set(paneKey, text)
}

export function consumeSessionPrepUndoBypass(paneKey: string, text: string): boolean {
  if (undoBypassByPane.get(paneKey) !== text) {
    return false
  }
  undoBypassByPane.delete(paneKey)
  return true
}

/** Bump so the status line polls immediately after a new request. */
export function noteSessionPrepBatch(paneKey: string): void {
  epochByPane.set(paneKey, (epochByPane.get(paneKey) ?? 0) + 1)
  emit()
}

export function subscribeSessionPrepEpoch(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange)
  return () => {
    listeners.delete(onStoreChange)
  }
}

export function getSessionPrepEpoch(paneKey: string): number {
  return epochByPane.get(paneKey) ?? 0
}

export function resetSessionPrepComposerStateForTests(): void {
  undoBypassByPane.clear()
  epochByPane.clear()
}
