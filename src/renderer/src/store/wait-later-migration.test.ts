// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { createWaitLaterStore } from './wait-later-store'
import { emptyWaitLater, type WaitLater } from '@/lib/wait-later'

describe('retired manual attention deadlines', () => {
  it('restores normal visibility while keeping completion and return evidence across restart', () => {
    const now = new Date('2026-09-13T15:00:00Z')
    const at = now.toISOString()
    let persisted: WaitLater = {
      ...emptyWaitLater(),
      until: { 'pane:unfinished': '2026-09-14T15:00:00Z', 'card:pending': '2026-09-15T15:00:00Z' },
      done: { 'pane:complete': at },
      returned: { 'pane:review': at }
    }
    const storage = {
      load: () => persisted,
      save: vi.fn((view: WaitLater) => {
        persisted = view
      })
    }
    const first = createWaitLaterStore(storage, () => now)
    first.getState().load()
    expect(first.getState().waiting.size).toBe(0)
    expect(first.getState().finished.get('pane:complete')).toBe(now.getTime())
    expect(first.getState().returned.get('pane:review')).toBe(now.getTime())
    expect(persisted.until).toEqual({})
    const restarted = createWaitLaterStore(storage, () => now)
    restarted.getState().load()
    expect(restarted.getState().view).toEqual(first.getState().view)
    expect(storage.save).toHaveBeenCalledTimes(1)
  })

  it('does not lose evidence when the migration cannot be saved', () => {
    const now = new Date('2026-09-13T15:00:00Z')
    const saved = {
      ...emptyWaitLater(),
      until: { 'pane:open': '2026-09-14T15:00:00Z' },
      returned: { 'pane:review': now.toISOString() }
    }
    const store = createWaitLaterStore(
      {
        load: () => saved,
        save: () => {
          throw new Error('disk full')
        }
      },
      () => now
    )
    store.getState().load()
    expect(store.getState().waiting.size).toBe(0)
    expect(store.getState().returned.has('pane:review')).toBe(true)
    expect(saved.until['pane:open']).toBeTruthy()
  })

  it('keeps a session snooze across restart while still retiring manual deadlines', () => {
    const now = new Date('2026-09-25T15:00:00Z')
    let persisted: WaitLater = {
      ...emptyWaitLater(),
      until: {
        'conversation:view-1': '2026-09-26T09:00:00Z',
        'conversation:view-2': '2026-09-25T09:00:00Z',
        'pane:old': '2026-09-26T09:00:00Z'
      }
    }
    const storage = {
      load: () => persisted,
      save: vi.fn((view: WaitLater) => {
        persisted = view
      })
    }
    const store = createWaitLaterStore(storage, () => now)
    store.getState().load()
    expect(store.getState().view.until).toEqual({ 'conversation:view-1': '2026-09-26T09:00:00Z' })
    expect([...store.getState().waiting]).toEqual(['conversation:view-1'])
    expect(persisted.until).toEqual({ 'conversation:view-1': '2026-09-26T09:00:00Z' })
  })
})
