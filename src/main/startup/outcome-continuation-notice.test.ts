import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const notificationShow = vi.fn()
const notificationSupported = vi.fn(() => true)
const notificationOptions: unknown[] = []

vi.mock('electron', () => ({
  app: { getLocale: () => 'en' },
  Notification: Object.assign(
    class {
      constructor(options: unknown) {
        notificationOptions.push(options)
      }
      show = notificationShow
    },
    { isSupported: () => notificationSupported() }
  )
}))

const { announceOutcomeContinuation, outcomeContinuationNotice } =
  await import('./outcome-continuation-notice')

describe('outcome continuation notice', () => {
  beforeEach(() => {
    notificationOptions.length = 0
    notificationShow.mockClear()
    notificationSupported.mockReturnValue(true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('tells the user the window-less process is alive and how to reach it', () => {
    expect(announceOutcomeContinuation(2)).toBe(true)
    expect(notificationShow).toHaveBeenCalledOnce()
    expect(notificationOptions).toEqual([outcomeContinuationNotice(2)])
    expect(outcomeContinuationNotice(2)?.body).toContain('Open OmniConsole')
  })

  it('logs the survivor even where a banner cannot be shown', () => {
    notificationSupported.mockReturnValue(false)
    expect(announceOutcomeContinuation(1)).toBe(false)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('pending=1'))
  })

  it('claims nothing is still running when nothing is', () => {
    expect(outcomeContinuationNotice(0)).toBeNull()
    expect(announceOutcomeContinuation(0)).toBe(false)
    expect(notificationShow).not.toHaveBeenCalled()
  })

  it('keeps the continuation alive when the banner throws', () => {
    notificationShow.mockImplementationOnce(() => {
      throw new Error('notification center unavailable')
    })
    expect(announceOutcomeContinuation(1)).toBe(false)
  })

  it('says sessions waiting on a review decision are still watched', () => {
    expect(outcomeContinuationNotice(0, 2)?.body).toContain('waiting for a review decision')
    expect(outcomeContinuationNotice(1, 2)?.body).toContain('Unfinished outcomes')
    notificationSupported.mockReturnValue(false)
    announceOutcomeContinuation(0, 2)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('reviewWaits=2'))
  })
})
