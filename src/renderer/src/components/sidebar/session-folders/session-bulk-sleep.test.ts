import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { SessionBulkItem } from './SessionBulkNextStep'
import { sleepableSessionItems, sleepSessionItems } from './session-bulk-sleep'

function item(key: string): SessionBulkItem {
  return { key, label: key, session: { rowKey: key } as SidebarSession }
}

describe('bulk put to sleep', () => {
  it('counts only the rows that can sleep', () => {
    const items = [item('a'), item('b'), item('c')]
    const sleepable = sleepableSessionItems(items, (session) =>
      session.rowKey === 'b'
        ? { ok: false, reason: 'no-live-pty' }
        : {
            ok: true,
            target: { worktreeId: 'w', tabId: 't', leafId: 'l', paneKey: 'p', ptyId: 'x' }
          }
    )
    expect(sleepable.map((entry) => entry.key)).toEqual(['a', 'c'])
  })

  it('sleeps one after another and keeps going past a refusal', async () => {
    const order: string[] = []
    let inFlight = 0
    const outcomes = await sleepSessionItems([item('a'), item('b'), item('c')], async (session) => {
      inFlight += 1
      expect(inFlight).toBe(1)
      order.push(`start:${session.rowKey}`)
      await Promise.resolve()
      order.push(`end:${session.rowKey}`)
      inFlight -= 1
      return session.rowKey === 'b' ? { ok: false, message: 'no id' } : { ok: true }
    })
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'])
    expect(outcomes).toEqual([
      { key: 'a', label: 'a', ok: true },
      { key: 'b', label: 'b', ok: false, message: 'no id' },
      { key: 'c', label: 'c', ok: true }
    ])
  })
})
