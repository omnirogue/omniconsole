// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBackofficeDeepLinks } from './use-backoffice-assignment-toasts'

const mocks = vi.hoisted(() => ({
  ready: false,
  openTaskPage: vi.fn(),
  subscribe: vi.fn(),
  toast: vi.fn(),
  focus: vi.fn()
}))
vi.mock('@/lib/console-account-scope', () => ({ selectConsoleAccountScope: () => 'person-scope' }))
vi.mock('@/components/task-page/backoffice/backoffice-work-selection', () => ({
  useBackofficeWorkFocus: { getState: () => ({ focus: mocks.focus }) }
}))
vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('../store', () => ({
  useAppStore: {
    getState: () => ({ persistedUIReady: mocks.ready, openTaskPage: mocks.openTaskPage }),
    subscribe: mocks.subscribe
  }
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

function Probe(): null {
  useBackofficeDeepLinks()
  return null
}

describe('backoffice deep-link lifecycle', () => {
  let root: Root | null = null
  let originalApi: PropertyDescriptor | undefined
  let container: HTMLDivElement
  let resolvePending: (target: { taskId: string } | null) => void
  let hydrate: (state: { persistedUIReady: boolean }) => void
  let unsubscribeHydration: ReturnType<typeof vi.fn>
  let unsubscribeOpenTask: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    mocks.ready = false
    unsubscribeHydration = vi.fn()
    unsubscribeOpenTask = vi.fn()
    mocks.subscribe.mockImplementation((callback) => {
      hydrate = callback
      return unsubscribeHydration
    })
    const pending = new Promise<{ taskId: string } | null>((resolve) => {
      resolvePending = resolve
    })
    originalApi = Object.getOwnPropertyDescriptor(window, 'api')
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        backoffice: {
          consumePendingOpenTask: () => pending,
          onOpenTask: () => unsubscribeOpenTask
        }
      }
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root?.render(<Probe />))
  })

  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
    if (originalApi) {
      Object.defineProperty(window, 'api', originalApi)
    } else {
      delete (window as unknown as { api?: unknown }).api
    }
    vi.unstubAllGlobals()
  })

  it('ignores an IPC result delivered after unmount and removes both listeners', async () => {
    act(() => root?.unmount())
    root = null
    mocks.ready = true
    await act(async () => {
      resolvePending({ taskId: 'btk_late' })
    })
    expect(mocks.openTaskPage).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(mocks.subscribe).toHaveBeenCalledOnce()
    expect(unsubscribeHydration).toHaveBeenCalledOnce()
    expect(unsubscribeOpenTask).toHaveBeenCalledOnce()
  })

  it('waits for startup hydration and opens the pending task once', async () => {
    await act(async () => {
      resolvePending({ taskId: 'btk_ready' })
    })
    expect(mocks.openTaskPage).not.toHaveBeenCalled()
    act(() => hydrate({ persistedUIReady: true }))
    act(() => hydrate({ persistedUIReady: true }))
    expect(mocks.openTaskPage).toHaveBeenCalledExactlyOnceWith({ taskSource: 'backoffice' })
    expect(mocks.focus).toHaveBeenCalledExactlyOnceWith({
      scope: 'person-scope',
      taskId: 'btk_ready'
    })
  })
})
