const writes = new Map<string, Promise<unknown>>()
export const routineBindingWritePending = (key: string): boolean => writes.has(key)
export function writeRoutineBinding<T>(key: string, action: () => Promise<T>): Promise<T> {
  const pending = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(action)
  writes.set(key, pending)
  void pending
    .finally(() => {
      if (writes.get(key) === pending) {
        writes.delete(key)
      }
    })
    .catch(() => {})
  return pending
}

export async function settleRoutineBindingWrites(key: string): Promise<void> {
  while (writes.has(key)) {
    await writes.get(key)
  }
}
