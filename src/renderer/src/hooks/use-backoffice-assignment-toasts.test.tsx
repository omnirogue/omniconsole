// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackofficeOpenTarget } from '../../../shared/backoffice-task-link'

const fixture = vi.hoisted(() => ({
  toast: vi.fn(),
  openTaskPage: vi.fn(),
  consumePendingOpenTask: vi.fn<() => Promise<BackofficeOpenTarget | null>>(),
  subscriptions: new Set<() => void>()
}))

vi.mock('sonner', () => ({ toast: fixture.toast }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  i18n: { language: 'en' }
}))
vi.mock('../store', async () => {
  const { createStore } = await import('zustand/vanilla')
  const store = createStore(() => ({
    persistedUIReady: false,
    activeOrcaProfileId: 'profile-a',
    openTaskPage: fixture.openTaskPage
  }))
  const subscribe = store.subscribe
  store.subscribe = (listener) => {
    const unsubscribe = subscribe(listener)
    const release = () => {
      unsubscribe()
      fixture.subscriptions.delete(release)
    }
    fixture.subscriptions.add(release)
    return release
  }
  return { useAppStore: store }
})

import { useBackofficeWorkFocus } from '@/components/task-page/backoffice/backoffice-work-selection'
import { useAppStore } from '../store'
import { useBackofficeDeepLinks } from './use-backoffice-assignment-toasts'

const originalApi = window.api
const openTaskListeners = new Set<(event: BackofficeOpenTarget) => void>()
let pendingTask: {
  promise: Promise<BackofficeOpenTarget | null>
  resolve: (target: BackofficeOpenTarget | null) => void
}
// Why: the scope the store yields with only a profile set; the request must carry exactly it.
const SCOPE = JSON.stringify(['profile-a', null, null, null, null, null, null, null])

function focused() {
  return useBackofficeWorkFocus.getState().request
}

beforeEach(() => {
  fixture.toast.mockClear()
  fixture.openTaskPage.mockClear()
  useAppStore.setState({ persistedUIReady: false })
  useBackofficeWorkFocus.setState({ request: null, missing: null })
  pendingTask = Promise.withResolvers<BackofficeOpenTarget | null>()
  fixture.consumePendingOpenTask.mockReset().mockImplementation(() => pendingTask.promise)
  Object.assign(window, {
    api: {
      backoffice: {
        consumePendingOpenTask: fixture.consumePendingOpenTask,
        onOpenTask: (listener: (event: BackofficeOpenTarget) => void) => {
          openTaskListeners.add(listener)
          return () => openTaskListeners.delete(listener)
        }
      }
    }
  })
})

afterEach(() => {
  cleanup()
  for (const release of fixture.subscriptions) {
    release()
  }
  openTaskListeners.clear()
  Object.assign(window, { api: originalApi })
})

describe('useBackofficeDeepLinks', () => {
  it('consumes the one-time pending task only for the active Strict Mode effect', async () => {
    const lifecycle: string[] = []
    useAppStore.setState({ persistedUIReady: true })
    fixture.consumePendingOpenTask
      .mockReset()
      .mockResolvedValueOnce({ taskId: 'btk_strict1234' })
      .mockResolvedValue(null)

    renderHook(
      () => {
        useEffect(() => {
          lifecycle.push('setup')
          return () => {
            lifecycle.push('cleanup')
          }
        }, [])
        useBackofficeDeepLinks()
      },
      { reactStrictMode: true }
    )
    await act(async () => {
      await Promise.resolve()
    })

    expect(lifecycle).toEqual(['setup', 'cleanup', 'setup'])
    expect(fixture.consumePendingOpenTask).toHaveBeenCalledTimes(1)
    expect(fixture.openTaskPage).toHaveBeenCalledExactlyOnceWith({ taskSource: 'backoffice' })
    expect(focused()).toEqual({ scope: SCOPE, taskId: 'btk_strict1234' })
    expect(fixture.toast).not.toHaveBeenCalled()
    expect(fixture.subscriptions.size).toBe(0)
  })

  it.each([false, true])(
    'ignores a pending result after unmount when hydration ready is %s',
    async (persistedUIReady) => {
      useAppStore.setState({ persistedUIReady })
      const hook = renderHook(() => useBackofficeDeepLinks())
      await act(async () => {
        await Promise.resolve()
      })
      expect(fixture.consumePendingOpenTask).toHaveBeenCalledTimes(1)

      hook.unmount()
      await act(async () => {
        pendingTask.resolve({ taskId: 'btk_late1234' })
        await pendingTask.promise
      })

      expect(fixture.subscriptions.size).toBe(0)
      expect(openTaskListeners.size).toBe(0)
      act(() => useAppStore.setState({ persistedUIReady: true }))
      expect(fixture.openTaskPage).not.toHaveBeenCalled()
      expect(focused()).toBeNull()
    }
  )

  it('releases a pending hydration wait on unmount', async () => {
    const hook = renderHook(() => useBackofficeDeepLinks())
    await act(async () => {
      pendingTask.resolve({ taskId: 'btk_wait1234' })
      await pendingTask.promise
    })
    expect(fixture.openTaskPage).not.toHaveBeenCalled()

    hook.unmount()
    expect(fixture.subscriptions.size).toBe(0)
    act(() => useAppStore.setState({ persistedUIReady: true }))

    expect(fixture.openTaskPage).not.toHaveBeenCalled()
    expect(focused()).toBeNull()
  })

  it('opens the pending task once after hydration and releases its subscription', async () => {
    renderHook(() => useBackofficeDeepLinks())
    await act(async () => {
      pendingTask.resolve({ taskId: 'btk_cold1234' })
      await pendingTask.promise
    })
    expect(fixture.openTaskPage).not.toHaveBeenCalled()
    expect(focused()).toBeNull()

    act(() => useAppStore.setState({ persistedUIReady: true }))

    expect(fixture.openTaskPage).toHaveBeenCalledExactlyOnceWith({ taskSource: 'backoffice' })
    expect(focused()).toEqual({ scope: SCOPE, taskId: 'btk_cold1234' })
    expect(fixture.subscriptions.size).toBe(0)

    act(() => {
      useAppStore.setState({ persistedUIReady: false })
      useAppStore.setState({ persistedUIReady: true })
    })
    expect(fixture.openTaskPage).toHaveBeenCalledTimes(1)
  })

  it('opens immediately if hydration finishes before the pending task arrives', async () => {
    renderHook(() => useBackofficeDeepLinks())
    act(() => useAppStore.setState({ persistedUIReady: true }))
    await act(async () => {
      pendingTask.resolve({ threadId: 'hth_ready1234' })
      await pendingTask.promise
    })

    expect(fixture.openTaskPage).toHaveBeenCalledExactlyOnceWith({ taskSource: 'backoffice' })
    expect(focused()).toEqual({ scope: SCOPE, threadId: 'hth_ready1234' })
    expect(fixture.subscriptions.size).toBe(0)
  })

  it('releases the hydration listener when there is no pending task', async () => {
    renderHook(() => useBackofficeDeepLinks())
    await act(async () => {
      pendingTask.resolve(null)
      await pendingTask.promise
    })

    expect(fixture.subscriptions.size).toBe(0)
    act(() => useAppStore.setState({ persistedUIReady: true }))
    expect(fixture.openTaskPage).not.toHaveBeenCalled()
    expect(focused()).toBeNull()
  })

  it('handles live deep links and removes their listener on unmount', async () => {
    const hook = renderHook(() => useBackofficeDeepLinks())
    await act(async () => {
      pendingTask.resolve(null)
      await pendingTask.promise
    })
    expect(openTaskListeners.size).toBe(1)
    act(() => {
      for (const listener of openTaskListeners) {
        listener({ threadId: 'hth_live1234' })
      }
    })
    expect(fixture.openTaskPage).toHaveBeenCalledExactlyOnceWith({ taskSource: 'backoffice' })
    expect(focused()).toEqual({ scope: SCOPE, threadId: 'hth_live1234' })

    hook.unmount()
    expect(openTaskListeners.size).toBe(0)
    act(() => {
      for (const listener of openTaskListeners) {
        listener({ taskId: 'btk_after1234' })
      }
    })
    expect(fixture.openTaskPage).toHaveBeenCalledTimes(1)
  })
})
