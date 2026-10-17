import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'

// Why: tests that mock `@/store` with a plain selector call hide Zustand's snapshot-identity
// loop (React #185). Mounting on the REAL store with createRoot + act is the only render that
// exercises `useSyncExternalStore`'s "getSnapshot should be cached" check.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const initialState = useAppStore.getInitialState()

export type RealStoreMount = {
  container: HTMLElement
  unmount: () => Promise<void>
}

export type MountOnRealStoreOptions = {
  /** Milliseconds to let mount effects and their follow-up renders run before returning. */
  settle?: number
  /**
   * Install a `window.api` whose every call stays pending forever. Pages that ask the main
   * process for data in a mount effect then draw exactly what they draw before the daemon
   * answers, which is the empty state these smoke tests assert on.
   */
  windowApi?: 'pending'
}

/** Restore the real store to its initial snapshot so state never leaks between tests. */
export function resetRealStore(): void {
  useAppStore.setState(initialState, true)
}

// Why: a callable thenable covers both shapes pages use at mount — `window.api.x.y().then(...)`
// and `const off = window.api.x.onY(cb)` — without pretending any request ever completed.
function createPendingApiNode(): unknown {
  const node = function pendingApiCall(): unknown {
    return createPendingApiNode()
  }
  return new Proxy(node, {
    get(_target, property) {
      if (property === 'then' || property === 'catch' || property === 'finally') {
        return () => createPendingApiNode()
      }
      if (typeof property === 'symbol') {
        return undefined
      }
      return createPendingApiNode()
    }
  })
}

/** Replace `window.api` with a never-answering stub; returns the restore function. */
export function installPendingWindowApi(): () => void {
  const previous = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: createPendingApiNode()
  })
  return () => {
    if (previous) {
      Object.defineProperty(window, 'api', previous)
    } else {
      Reflect.deleteProperty(window, 'api')
    }
  }
}

/**
 * Mount `element` with createRoot + act on the real `useAppStore`, wrapped in the same
 * providers the app shell supplies (TooltipProvider, ConfirmationDialogProvider).
 */
export async function mountOnRealStore(
  element: ReactNode,
  options: MountOnRealStoreOptions = {}
): Promise<RealStoreMount> {
  const restoreApi = options.windowApi === 'pending' ? installPendingWindowApi() : null
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(
      <TooltipProvider>
        <ConfirmationDialogProvider>{element}</ConfirmationDialogProvider>
      </TooltipProvider>
    )
    await new Promise((resolve) => setTimeout(resolve, options.settle ?? 30))
  })
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
      restoreApi?.()
    }
  }
}
