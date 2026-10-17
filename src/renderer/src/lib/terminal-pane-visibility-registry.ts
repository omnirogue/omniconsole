/**
 * Each mounted TerminalPane's own live visibility (`isVisibleRef`: its tab shown and its worktree
 * active), by tab. The PTY exit handler reads that same ref to decide whether a slept pane wakes
 * at once (pty-exit-hibernate.ts); archive sleep reads it here, so "on screen" means one thing.
 * A tab with no mounted pane is not visible.
 */

type VisibleRef = { readonly current: boolean }

const refsByTabId = new Map<string, Set<VisibleRef>>()

export function registerTerminalPaneVisibility(tabId: string, ref: VisibleRef): () => void {
  let refs = refsByTabId.get(tabId)
  if (!refs) {
    refs = new Set()
    refsByTabId.set(tabId, refs)
  }
  refs.add(ref)
  return () => {
    const current = refsByTabId.get(tabId)
    current?.delete(ref)
    if (current?.size === 0) {
      refsByTabId.delete(tabId)
    }
  }
}

export function isTerminalTabRendererVisible(tabId: string): boolean {
  for (const ref of refsByTabId.get(tabId) ?? []) {
    if (ref.current) {
      return true
    }
  }
  return false
}
