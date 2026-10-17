/**
 * Where agent sleep keeps each pane's PTY binding across an app restart: its first-seen stamp, its
 * last keystroke and reveal, and the daemon lifetime it was seen in (agent-hibernation-pane-age.ts).
 */

export type StoredBinding = {
  ptyId: string
  firstSeenAt: number
  inputAt?: number
  revealAt?: number
  identity?: string
}
export type BindingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export const PTY_BINDING_AGE_STORAGE_KEY = 'omni.agent-hibernation-pty-binding-age.v1'

/** The previous app run's bindings, read once; each is consumed by its pane's first sight. */
let storedBindingByPaneKey: Map<string, StoredBinding> | null = null
let storageOverride: BindingStorage | null | undefined

function bindingStorage(): BindingStorage | null {
  if (storageOverride !== undefined) {
    return storageOverride
  }
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function finiteStamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function readStoredBindings(): Map<string, StoredBinding> {
  if (storedBindingByPaneKey) {
    return storedBindingByPaneKey
  }
  storedBindingByPaneKey = new Map()
  try {
    const raw = bindingStorage()?.getItem(PTY_BINDING_AGE_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object') {
      for (const [paneKey, value] of Object.entries(parsed as Record<string, unknown>)) {
        const binding = value as Partial<StoredBinding> | null
        if (
          typeof binding?.ptyId === 'string' &&
          binding.ptyId &&
          typeof binding.firstSeenAt === 'number' &&
          Number.isFinite(binding.firstSeenAt)
        ) {
          storedBindingByPaneKey.set(paneKey, {
            ptyId: binding.ptyId,
            firstSeenAt: binding.firstSeenAt,
            inputAt: finiteStamp(binding.inputAt),
            revealAt: finiteStamp(binding.revealAt),
            ...(typeof binding.identity === 'string' && binding.identity
              ? { identity: binding.identity }
              : {})
          })
        }
      }
    }
  } catch {
    // Why: unreadable storage only costs the restart grace this file always gave (fresh stamps).
  }
  return storedBindingByPaneKey
}

/** The previous run's binding for a pane, handed out once (its first sight in this run). */
export function takeStoredBinding(paneKey: string): StoredBinding | undefined {
  const stored = readStoredBindings().get(paneKey)
  readStoredBindings().delete(paneKey)
  return stored
}

export function writeStoredBindings(bindings: Iterable<[string, StoredBinding]>): void {
  try {
    bindingStorage()?.setItem(
      PTY_BINDING_AGE_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(bindings))
    )
  } catch {
    // Why: a full or blocked storage must never stop agent sleep; the next run just gets grace.
  }
}

/** What an app restart does to the storage side: the next first sight reads it again. */
export function forgetStoredBindingReadForTests(): void {
  storedBindingByPaneKey = null
}

export function setBindingStorageForTests(storage: BindingStorage | null | undefined): void {
  storageOverride = storage
  storedBindingByPaneKey = null
}

export function clearBindingStorageForTests(): void {
  try {
    bindingStorage()?.removeItem(PTY_BINDING_AGE_STORAGE_KEY)
  } catch {
    // Test storage only.
  }
}
