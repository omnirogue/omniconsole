/**
 * Project items the person left out of one session (plan §8: the last step of the inheritance
 * order), kept beside that session's context entry under the same key and moved with it when a
 * tab learns its session identity. Per device, like the entry itself.
 */
const STORAGE_KEY = 'omni.session-context-removed.v1'

function read(): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string[]>)
      : {}
  } catch {
    return {}
  }
}

export function getSessionContextRemovals(key: string): readonly string[] {
  const removed = read()[key]
  return Array.isArray(removed) ? removed.filter((id) => typeof id === 'string') : []
}

export function setSessionContextRemovals(key: string, removed: readonly string[]): void {
  if (removed.length) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...read(), [key]: [...removed] }))
  }
}

export function moveSessionContextRemovals(from: string, to: string): void {
  const removed = read()
  if (!removed[from]) {
    return
  }
  removed[to] ??= removed[from]
  delete removed[from]
  localStorage.setItem(STORAGE_KEY, JSON.stringify(removed))
}
