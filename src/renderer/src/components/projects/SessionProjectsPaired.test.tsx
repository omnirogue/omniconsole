// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = {
  runtimeEnvironments: [
    { id: 'env-1', name: 'Office Mac' },
    { id: 'env-old', name: 'Old Mac' }
  ],
  runtimeStatusByEnvironmentId: new Map([
    ['env-1', { status: { capabilities: ['session-projects.list.v1'] } }],
    ['env-old', { status: { capabilities: [] } }]
  ])
}
vi.mock('@/store', () => ({
  useAppStore: (select: (s: typeof state) => unknown) => select(state)
}))

import { SessionProjectsPaired } from './SessionProjectsPaired'

const call = vi.fn()
beforeEach(() => {
  call.mockReset()
  vi.stubGlobal('window', Object.assign(window, { api: { runtimeEnvironments: { call } } }))
})
afterEach(() => {
  cleanup()
})

it('lists a paired computer’s projects, and skips one that cannot list them', async () => {
  call.mockResolvedValue({
    id: 'r',
    ok: true,
    result: {
      projects: [
        {
          folderId: 'f1',
          name: 'Checkout',
          path: 'Shop/Checkout',
          company: 'Shop',
          repos: 1,
          threads: { total: 3, byStatus: { needsYou: 1 } }
        }
      ]
    },
    _meta: { runtimeId: 'x' }
  })
  render(<SessionProjectsPaired />)
  expect(await screen.findByText('Checkout')).not.toBeNull()
  expect(screen.getByText('On Office Mac')).not.toBeNull()
  expect(screen.getByText('3 threads · 1 need you')).not.toBeNull()
  expect(screen.queryByText('On Old Mac')).toBeNull()
  expect(call).toHaveBeenCalledWith({
    selector: 'env-1',
    method: 'sessionProjects.list',
    params: {}
  })
})

it('says why when the computer refused', async () => {
  call.mockRejectedValue(new Error('Not paired'))
  render(<SessionProjectsPaired />)
  expect(await screen.findByText('Could not list its projects: Not paired')).not.toBeNull()
})
