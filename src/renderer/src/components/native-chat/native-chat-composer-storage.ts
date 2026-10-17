/** Scope already includes the Console account and stable pane identity. */
export function nativeChatComposerStorageKey(kind: string, scope: string): string {
  return `omni.native-chat-composer.v1:${JSON.stringify([kind, scope])}`
}

export function readNativeChatComposerStorage<T>(kind: string, scope: string): T | undefined {
  if (typeof localStorage === 'undefined') {
    return undefined
  }
  const raw = localStorage.getItem(nativeChatComposerStorageKey(kind, scope))
  if (raw === null) {
    return undefined
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

export function writeNativeChatComposerStorage(kind: string, scope: string, value: unknown): void {
  if (typeof localStorage === 'undefined') {
    return
  }
  const key = nativeChatComposerStorageKey(kind, scope)
  if (value === undefined) {
    localStorage.removeItem(key)
  } else {
    localStorage.setItem(key, JSON.stringify(value))
  }
}

export function clearNativeChatComposerStorageForTests(kind: string): void {
  if (typeof localStorage === 'undefined') {
    return
  }
  const prefix = `omni.native-chat-composer.v1:[${JSON.stringify(kind)},`
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(prefix)) {
      localStorage.removeItem(key)
    }
  }
}
