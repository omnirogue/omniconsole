import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))

import { installArtifactPreviewGuestPolicy } from './artifact-preview-guest-policy'

type WindowOpenHandler = (details: { url: string }) => { action: string }

function fakeGuest() {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  let windowOpenHandler: WindowOpenHandler | null = null
  return {
    guest: {
      setWindowOpenHandler: vi.fn((handler: WindowOpenHandler) => {
        windowOpenHandler = handler
      }),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener)
      }),
      off: vi.fn((event: string) => {
        listeners.delete(event)
      })
    },
    navigate: (url: string) => {
      const event = { preventDefault: vi.fn() }
      listeners.get('will-navigate')?.(event, url)
      return event
    },
    openWindow: (url: string) => windowOpenHandler?.({ url }),
    hasNavigationListener: () => listeners.has('will-navigate')
  }
}

describe('installArtifactPreviewGuestPolicy', () => {
  it('keeps the preview in place and sends a clicked link to the system browser', () => {
    const { guest, navigate } = fakeGuest()
    const openExternal = vi.fn().mockResolvedValue(undefined)
    installArtifactPreviewGuestPolicy(guest as never, openExternal, () => 10_000)

    const event = navigate('https://console.example.com/a/plan')

    expect(event.preventDefault).toHaveBeenCalled()
    expect(openExternal).toHaveBeenCalledWith('https://console.example.com/a/plan')
  })

  it('denies popups and routes them to the system browser', () => {
    const { guest, openWindow } = fakeGuest()
    const openExternal = vi.fn().mockResolvedValue(undefined)
    installArtifactPreviewGuestPolicy(guest as never, openExternal, () => 10_000)

    expect(openWindow('https://docs.example.com/')).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledWith('https://docs.example.com/')
  })

  it('never hands local or script URLs to the OS, and throttles a page that loops', () => {
    const { guest, navigate, openWindow } = fakeGuest()
    const openExternal = vi.fn().mockResolvedValue(undefined)
    let now = 10_000
    installArtifactPreviewGuestPolicy(guest as never, openExternal, () => now)

    navigate('file:///etc/passwd')
    openWindow('javascript:alert(1)')
    expect(openExternal).not.toHaveBeenCalled()

    openWindow('https://a.example.com/')
    openWindow('https://b.example.com/')
    expect(openExternal).toHaveBeenCalledTimes(1)
    now += 1_000
    openWindow('https://c.example.com/')
    expect(openExternal).toHaveBeenCalledTimes(2)
  })

  it('removes its navigation listener on dispose', () => {
    const { guest, hasNavigationListener } = fakeGuest()
    const dispose = installArtifactPreviewGuestPolicy(guest as never, vi.fn(), () => 0)
    expect(hasNavigationListener()).toBe(true)
    dispose()
    expect(hasNavigationListener()).toBe(false)
  })
})
