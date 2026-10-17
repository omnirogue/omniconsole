// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  OrganizationRecord,
  OrganizationUndoPlan
} from '../../../../shared/session-organization-change'

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), toastMocks) }))
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (_target: unknown, method: string, params: unknown) => rpc(method, params)
}))
vi.mock('@/components/sidebar/session-folders/use-sidebar-sessions', () => ({
  useSidebarSessions: () => []
}))
vi.mock('@/components/sidebar/session-folders/use-junk-title-repairs', () => ({
  useJunkTitleRepairs: () => [
    { tabId: 't1', previous: 'worker-task_5ad8df40da3a', next: 'Fix the PDF export' }
  ]
}))

import { WorkStewardActivitySection } from './WorkStewardActivitySection'

const organize: OrganizationRecord = {
  opId: 'organize-1',
  kind: 'archive',
  targets: Array.from({ length: 100 }, (_, index) => ({ sessionKey: `s${index}` })),
  value: true,
  executor: { kind: 'pane', paneKey: 'tab-9:leaf-9', title: 'Steward' },
  request: 'keep my sidebar within five',
  reason: 'finished and idle',
  phase: 'applied',
  ts: new Date().toISOString()
}

afterEach(() => {
  cleanup()
  rpc.mockReset()
  toastMocks.success.mockReset()
})

describe('WorkStewardActivitySection', () => {
  it('lists a bulk change by the request that asked for it and undoes it as one', async () => {
    const plan: OrganizationUndoPlan = {
      opId: 'organize-1',
      inverse: {
        kind: 'unarchive',
        targets: organize.targets,
        value: false,
        undoOf: 'organize-1'
      },
      targets: organize.targets.map((target) => ({ target, status: 'undo', expected: true })),
      partial: false
    }
    rpc.mockImplementation(async (method: string) => {
      if (method === 'sessionOrganization.recent') {
        return { entries: [organize], undoable: ['organize-1'] }
      }
      if (method === 'sessionOrganization.undoPlan') {
        return plan
      }
      return {}
    })
    render(<WorkStewardActivitySection />)
    await screen.findByText('“keep my sidebar within five”')
    expect(screen.getByText(/1 changes · 100 sessions/)).toBeTruthy()
    expect(screen.getByText('Archived (100 sessions) · finished and idle')).toBeTruthy()
    expect(screen.getByText(/1 session has a launcher title like worker-task_…/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('sessionOrganization.undoPlan', { opId: 'organize-1' })
    )
  })
})
