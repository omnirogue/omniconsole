import { BackofficeNotModified } from '@/lib/backoffice-not-modified'
import { notifyWorkArrivals } from '@/components/handoffs/handoff-notifications'
import { useBackofficeWorkStore } from './backoffice-work-store'
import type { WorkLoad, WorkReads } from './backoffice-work-reads'
import { isUnservedRead } from './backoffice-work-pages'

export function previousOf<T>(load: WorkLoad<T>): T | null {
  if (load.phase === 'ready') {
    return load.value
  }
  return load.phase === 'loading' || load.phase === 'error' ? load.previous : null
}

export function createWorkReadLoader(isCurrent: (scope: string, generation: number) => boolean) {
  return async function loadRead<K extends keyof WorkReads>(
    scope: string,
    gen: number,
    key: K,
    read: () => Promise<WorkReads[K] extends WorkLoad<infer T> ? T : never>,
    unservedWhenRefused = false
  ): Promise<void> {
    const write = (value: WorkReads[K]): void => {
      if (isCurrent(scope, gen)) {
        useBackofficeWorkStore.setState({ [key]: value } as Partial<
          ReturnType<typeof useBackofficeWorkStore.getState>
        >)
        notifyWorkArrivals(scope, useBackofficeWorkStore.getState())
      }
    }
    const previous = previousOf(useBackofficeWorkStore.getState()[key] as WorkLoad<unknown>)
    if (previous === null) {
      write({ phase: 'loading', previous } as WorkReads[K])
    }
    try {
      const value = await read()
      if (value !== previous) {
        write({ phase: 'ready', value } as WorkReads[K])
      }
    } catch (error) {
      if (error instanceof BackofficeNotModified && previous !== null) {
        return
      }
      write(
        (unservedWhenRefused && isUnservedRead(error)
          ? { phase: 'not-served' }
          : {
              phase: 'error',
              message: error instanceof Error ? error.message : String(error),
              previous
            }) as WorkReads[K]
      )
    }
  }
}
