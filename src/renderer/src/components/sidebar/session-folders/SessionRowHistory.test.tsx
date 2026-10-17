// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type {
  OrganizationRecord,
  OrganizationUndoPlan
} from '../../../../../shared/session-organization-change'
import type { OrganizationSessionHistory } from '../../../../../shared/session-organization-readers'

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), toastMocks) }))
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (_target: unknown, method: string, params: unknown) => rpc(method, params)
}))

import { SessionRowHistory } from './SessionRowHistory'

const session: SidebarSession = {
  rowKey: 'row-1',
  sessionKey: 'claude:abc',
  worktreeId: 'folder:1',
  hostId: 'local',
  tabId: 'tab-1',
  paneKey: 'tab-1:leaf-1',
  kind: 'terminal',
  label: 'Checkout fixes',
  workspaceLabel: 'Website',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
}

const moved: OrganizationRecord = {
  opId: 'move-1',
  kind: 'move',
  targets: [{ sessionKey: 'claude:abc' }],
  value: null,
  executor: { kind: 'pane', paneKey: 'tab-9:leaf-9', title: 'Ads review' },
  reason: 'it is done',
  phase: 'applied',
  ts: new Date().toISOString()
}

afterEach(() => {
  cleanup()
  rpc.mockReset()
  toastMocks.warning.mockReset()
})

describe('SessionRowHistory', () => {
  it('reads the row’s history on open, and an Undo refused as changed since says so', async () => {
    const history: OrganizationSessionHistory = {
      key: 'claude:abc',
      entries: [moved],
      pending: [],
      ownership: {},
      revocations: {},
      undoable: ['move-1']
    }
    const plan: OrganizationUndoPlan = {
      opId: 'move-1',
      inverse: null,
      targets: [{ target: { sessionKey: 'claude:abc' }, status: 'changed-since', laterOpId: 'x' }],
      partial: false
    }
    rpc.mockImplementation(async (method: string) =>
      method === 'sessionOrganization.history' ? history : plan
    )
    render(<SessionRowHistory session={session} />)
    expect(rpc).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /History/ }))
    await screen.findByText(/Moved to Unfiled/)
    expect(rpc).toHaveBeenCalledWith('sessionOrganization.history', {
      key: 'claude:abc',
      aliases: ['pane:tab-1:leaf-1', 'tab:tab-1']
    })
    expect(screen.getByText(/by “Ads review” · it is done/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() =>
      expect(toastMocks.warning).toHaveBeenCalledWith(
        'Nothing was undone: it changed since, so it was left as it is.'
      )
    )
    expect(rpc).toHaveBeenCalledWith('sessionOrganization.undoPlan', { opId: 'move-1' })
  })
})
