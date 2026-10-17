// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StarNagToastHost } from './StarNagToastHost'

type ShowPayload = { mode?: 'gh' | 'web'; surface?: 'card' | 'toast' }
type ShowCallback = (payload?: ShowPayload) => void
type CustomToastOptions = {
  dismissible?: boolean
  onDismiss?: () => void
}

const toastDismissMock = vi.hoisted(() => vi.fn())
const customToastMock = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    custom: customToastMock,
    dismiss: toastDismissMock
  }
}))

type StarNagApi = {
  onShow: (callback: ShowCallback) => () => void
  onHide: (callback: () => void) => () => void
  dismiss: ReturnType<typeof vi.fn>
  later: ReturnType<typeof vi.fn>
  openWeb: ReturnType<typeof vi.fn>
  starOrca: ReturnType<typeof vi.fn>
}

type ShellApi = {
  openUrl: ReturnType<typeof vi.fn>
}

function setApi(api: { starNag: StarNagApi; shell: ShellApi }): void {
  ;(window as unknown as { api: typeof api }).api = api
}

function renderHost(): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<StarNagToastHost />)
  })
  return { root, container }
}

function renderToastFromCustomCall(container: HTMLElement): Root {
  const render = customToastMock.mock.calls[0][0] as (id: string | number) => React.ReactElement
  const root = createRoot(container)
  act(() => {
    root.render(render('toast-1'))
  })
  return root
}

describe('StarNagToastHost', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null
  let toastContainer: HTMLDivElement | null = null
  let toastRoot: Root | null = null
  let showCallback: ShowCallback | null = null
  let hideCallback: (() => void) | null = null
  let starNag: StarNagApi
  let shell: ShellApi
  let toastIdCounter = 0

  beforeEach(() => {
    customToastMock.mockReset()
    customToastMock.mockImplementation(() => `toast-${++toastIdCounter}`)
    toastDismissMock.mockReset()
    showCallback = null
    hideCallback = null
    toastIdCounter = 0
    starNag = {
      onShow: vi.fn((callback: ShowCallback) => {
        showCallback = callback
        return vi.fn()
      }),
      onHide: vi.fn((callback: () => void) => {
        hideCallback = callback
        return vi.fn()
      }),
      dismiss: vi.fn().mockResolvedValue(undefined),
      later: vi.fn().mockResolvedValue(undefined),
      openWeb: vi.fn().mockResolvedValue(undefined),
      starOrca: vi.fn().mockResolvedValue(true)
    }
    shell = {
      openUrl: vi.fn().mockResolvedValue(undefined)
    }
    setApi({ starNag, shell })
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    if (toastRoot) {
      act(() => toastRoot?.unmount())
    }
    container?.remove()
    toastContainer?.remove()
    root = null
    container = null
    toastContainer = null
    toastRoot = null
  })

  it.each(['gh', 'web'] as const)(
    'confirms onboarding without upstream actions in %s mode',
    (mode) => {
      ;({ root, container } = renderHost())
      act(() => showCallback?.({ mode, surface: 'toast' }))
      toastContainer = document.createElement('div')
      document.body.appendChild(toastContainer)
      toastRoot = renderToastFromCustomCall(toastContainer)

      expect(toastContainer.textContent).toBe('Onboarding completed!')
      expect(toastContainer.querySelectorAll('button')).toHaveLength(1)
      const closeButton = toastContainer.querySelector('button')
      expect(closeButton?.getAttribute('aria-label')).toBe('Dismiss')
      expect(closeButton?.disabled).toBe(false)
      expect((customToastMock.mock.calls[0][1] as CustomToastOptions).dismissible).toBe(false)
      expect(starNag.starOrca).not.toHaveBeenCalled()
      expect(starNag.openWeb).not.toHaveBeenCalled()
      expect(starNag.later).not.toHaveBeenCalled()
      expect(shell.openUrl).not.toHaveBeenCalled()

      act(() => closeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      expect(toastDismissMock).toHaveBeenCalledWith('toast-1')
      const options = customToastMock.mock.calls[0][1] as CustomToastOptions
      act(() => options.onDismiss?.())
      expect(starNag.dismiss).toHaveBeenCalledTimes(1)
    }
  )

  it('ignores notifications intended for the existing card surface', () => {
    ;({ root, container } = renderHost())
    act(() => showCallback?.({ mode: 'gh', surface: 'card' }))
    expect(customToastMock).not.toHaveBeenCalled()
  })

  it('does not dismiss the current main session when replacing an active toast', () => {
    ;({ root, container } = renderHost())

    act(() => showCallback?.({ mode: 'gh', surface: 'toast' }))
    const firstOptions = customToastMock.mock.calls[0][1] as CustomToastOptions

    act(() => showCallback?.({ mode: 'web', surface: 'toast' }))
    const secondOptions = customToastMock.mock.calls[1][1] as CustomToastOptions
    act(() => firstOptions.onDismiss?.())

    expect(toastDismissMock).toHaveBeenCalledWith('toast-1')
    expect(starNag.dismiss).not.toHaveBeenCalled()

    act(() => showCallback?.({ mode: 'gh', surface: 'toast' }))
    const thirdOptions = customToastMock.mock.calls[2][1] as CustomToastOptions
    act(() => secondOptions.onDismiss?.())

    expect(starNag.dismiss).not.toHaveBeenCalled()

    act(() => thirdOptions.onDismiss?.())

    expect(starNag.dismiss).toHaveBeenCalledTimes(1)
  })

  it('dismisses active toast on hide without recording a user dismissal', () => {
    ;({ root, container } = renderHost())

    act(() => showCallback?.({ mode: 'gh', surface: 'toast' }))
    act(() => hideCallback?.())
    const options = customToastMock.mock.calls[0][1] as CustomToastOptions
    act(() => options.onDismiss?.())

    expect(toastDismissMock).toHaveBeenCalledWith('toast-1')
    expect(starNag.dismiss).not.toHaveBeenCalled()
  })
})
