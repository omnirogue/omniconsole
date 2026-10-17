const listeners = new Set<(paneId: string) => void>()

export function flashSessionGridPane(paneId: string): void {
  listeners.forEach((listener) => listener(paneId))
}

export function subscribeSessionGridPaneFlash(listener: (paneId: string) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
