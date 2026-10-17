// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { EnterpriseFunnelPanel } from './EnterpriseFunnelPanel'

const readKeys = vi.hoisted(() => [] as string[])
vi.mock('./advertising-client', () => ({
  advertisingApi: () => ({ webinar: vi.fn() }),
  useAdvertisingRead: (_read: unknown, key: string) => {
    readKeys.push(key)
    return { data: null, error: null, loading: false, reload: vi.fn() }
  }
}))

afterEach(() => readKeys.splice(0))

it('refreshes both webinar windows when the page refreshes', () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(<EnterpriseFunnelPanel revision={0} />))
  expect(readKeys).toContain('webinar:today:0')
  expect(readKeys).toContain('webinar:d7:0')
  act(() => root.render(<EnterpriseFunnelPanel revision={1} />))
  expect(readKeys).toContain('webinar:today:1')
  expect(readKeys).toContain('webinar:d7:1')
  act(() => root.unmount())
  host.remove()
})
