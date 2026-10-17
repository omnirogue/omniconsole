// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  SessionStewardStatus,
  StewardResultCard
} from '../../../../shared/session-steward-status'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() })
}))
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (_target: unknown, method: string, params: unknown) => rpc(method, params)
}))
const opened = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/lib/activate-sidebar-session', () => ({ activateSidebarSession: opened }))
vi.mock('@/components/sidebar/session-folders/use-sidebar-sessions', () => ({
  useSidebarSessions: () => [{ kind: 'terminal', paneKey: 'tab-1:leaf-1', label: 'Parser fix' }]
}))
vi.mock('@/lib/personal-view-storage', () => ({ personalViewStorageKey: (key: string) => key }))

import { WorkStewardStatus } from './WorkStewardStatus'

const NOW = Date.now()
const status: SessionStewardStatus = {
  off: null,
  stalled: [
    {
      paneKey: 'tab-1:leaf-1',
      title: 'Parser fix',
      at: NOW - 60_000,
      reason: 'Its latest reply ends on a question, so a free prompt could read as the answer.'
    }
  ],
  silent: [{ paneKey: 'tab-2:leaf-1', title: 'Big build', since: NOW - 900_000, minutes: 15 }],
  activity: [
    { at: NOW - 5_000, kind: 'archive', summary: 'Archived' },
    { at: NOW - 4_000, kind: 'yes', summary: 'Answered' },
    { at: NOW - 3_000, kind: 'refused', summary: 'Left' }
  ],
  prompts: { today: 1 }
}

function card(key: string, title: string, archivedAt: number): StewardResultCard {
  return {
    key,
    paneKey: `pane-${key}`,
    title,
    goal: 'Fix it',
    lastReply: `${title} is done and the tests pass.`,
    pullRequests: [
      { owner: 'acme', repo: 'app', number: 12, url: 'https://github.com/acme/app/pull/12' }
    ],
    changedFiles: ['a.ts', 'b.ts'],
    branch: 'fix',
    outcomeReceipts: [],
    artifacts: [],
    evidence: 'JEV resolved 0.91 · quiet 7 h',
    builtAt: archivedAt - 1_000,
    archivedAt,
    opId: `op-${key}`
  }
}

afterEach(() => {
  cleanup()
  rpc.mockReset()
  localStorage.clear()
})

describe('WorkStewardStatus', () => {
  it('shows the steward’s moves, Stalled and silent sessions, and finished work, new first', async () => {
    localStorage.setItem('omni.steward-finished-seen.v1', String(NOW - 30 * 60_000))
    rpc.mockImplementation(async (method: string) => {
      if (method === 'sessionSteward.status') {
        return status
      }
      if (method === 'sessionSteward.finished') {
        return {
          cards: [
            card('old', 'Old report', NOW - 3_600_000),
            card('new', 'Checkout fix', NOW - 60_000)
          ]
        }
      }
      if (method === 'sessionOrganization.undoPlan') {
        return { opId: 'op-new', inverse: null, targets: [], partial: false }
      }
      return {}
    })
    render(<WorkStewardStatus />)
    expect(
      await screen.findByText(
        'Steward, last 24 h: said yes 1 · archived 1 · left 1 for you · prompts sent today: 1'
      )
    ).toBeTruthy()
    expect(
      screen.getByText(
        'Stalled: Its latest reply ends on a question, so a free prompt could read as the answer.'
      )
    ).toBeTruthy()
    expect(screen.getByText('Working, no output for 15 min; a restart may help')).toBeTruthy()
    expect(await screen.findByText('Finished since you last looked · 1')).toBeTruthy()
    const rows = document.querySelectorAll('[data-steward-finished]')
    expect([...rows].map((row) => row.getAttribute('data-steward-finished'))).toEqual([
      'new',
      'old'
    ])
    expect(rows[0]!.getAttribute('data-steward-unseen')).toBe('true')
    expect(rows[1]!.getAttribute('data-steward-unseen')).toBe('false')
    expect(
      screen.getAllByText(/^Finished, not verified · JEV resolved 0\.91 · quiet 7 h/)
    ).toHaveLength(2)
    expect(screen.getAllByText('Pull requests: 1 · Changed files: 2')).toHaveLength(2)

    await userEvent.click(screen.getAllByRole('button', { name: 'Open' })[0]!)
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ paneKey: 'tab-1:leaf-1' }))

    await userEvent.click(screen.getAllByRole('button', { name: 'Undo' })[0]!)
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('sessionOrganization.undoPlan', { opId: 'op-new' })
    )

    await userEvent.click(screen.getByRole('button', { name: 'Mark seen' }))
    expect(await screen.findByText('Finished since you last looked · 0')).toBeTruthy()
    expect(Number(localStorage.getItem('omni.steward-finished-seen.v1'))).toBeGreaterThan(NOW - 1)
  })
})
