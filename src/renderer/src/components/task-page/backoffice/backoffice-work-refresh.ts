import { installBackofficeAdaptivePoller } from '@/lib/backoffice-adaptive-poller'
/** One refresh loop per signed-in scope, shared by badges, lists and recipient controls. */
const readers = new Map<string, { count: number; stop: () => void }>()
export function subscribeWorkRefresh(
  scope: string,
  refresh: (wake?: boolean) => Promise<void> | void
): () => void {
  let entry = readers.get(scope)
  if (!entry) {
    entry = { count: 0, stop: installBackofficeAdaptivePoller(refresh, false) }
    readers.set(scope, entry)
  }
  entry.count += 1
  return () => {
    entry.count -= 1
    if (entry.count === 0) {
      entry.stop()
      readers.delete(scope)
    }
  }
}
