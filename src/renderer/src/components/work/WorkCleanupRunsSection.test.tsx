// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CleanupRunsView } from '../../../../shared/session-cleanup-run'

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), toastMocks) }))
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (_target: unknown, method: string, params: unknown) => rpc(method, params)
}))

import { WorkCleanupRunsSection } from './WorkCleanupRunsSection'

const at = new Date('2026-09-25T09:05:00').getTime()
const view: CleanupRunsView = {
  active: null,
  runs: [
    {
      runId: 'run-2',
      source: 'automatic',
      status: 'completed',
      title: 'Session cleanup run 2 · automatic',
      createdAt: at,
      paneKey: null,
      report: 'Archived 4 finished sessions. Held 2: open commitments.',
      error: null
    },
    {
      runId: 'run-1',
      source: 'manual',
      status: 'dispatch_failed',
      title: 'Session cleanup run 1 · Clean up now',
      createdAt: at - 3_600_000,
      paneKey: null,
      report: null,
      error: 'OmniConsole stopped before this cleanup run started, so it never ran.'
    }
  ],
  skipped: [
    { at, reason: 'capacity', detail: 'capacity (codex)', why: 'the account is limited', count: 3 }
  ],
  automaticToday: 1,
  dailyCap: 3,
  automaticOn: true
}

afterEach(() => {
  cleanup()
  rpc.mockReset()
  toastMocks.success.mockReset()
  toastMocks.warning.mockReset()
})

describe('WorkCleanupRunsSection', () => {
  it('shows each run with its trigger and report, and skips with their reason', async () => {
    rpc.mockResolvedValue(view)
    render(<WorkCleanupRunsSection />)

    await screen.findByText('Archived 4 finished sessions. Held 2: open commitments.')
    expect(screen.getByText('1 of 3 automatic today')).toBeTruthy()
    expect(screen.getByText(/^Automatic · .* · finished$/)).toBeTruthy()
    expect(screen.getByText(/^Clean up now · .* · failed$/)).toBeTruthy()
    expect(screen.getByText(/never ran/)).toBeTruthy()
    expect(
      screen.getByText(/Skipped: capacity \(codex\) · .* ×3 · the account is limited/)
    ).toBeTruthy()
  })

  it('starts a cleanup on Clean up now and says why when one is already going', async () => {
    rpc.mockImplementation(async (method: string) =>
      method === 'sessionSteward.cleanupNow'
        ? {
            ok: false,
            reason: 'running',
            detail: 'An automatic cleanup run is already going (since 09:05).'
          }
        : view
    )
    render(<WorkCleanupRunsSection />)
    await userEvent.click(await screen.findByRole('button', { name: 'Clean up now' }))

    await waitFor(() =>
      expect(toastMocks.warning).toHaveBeenCalledWith(
        'An automatic cleanup run is already going (since 09:05).'
      )
    )
    expect(rpc).toHaveBeenCalledWith('sessionSteward.cleanupNow', undefined)
  })

  it('disables the button while a run holds the slot', async () => {
    rpc.mockResolvedValue({
      ...view,
      active: { source: 'automatic', takenAt: at, run: null }
    } satisfies CleanupRunsView)
    render(<WorkCleanupRunsSection />)

    const button = await screen.findByRole('button', { name: 'Cleaning up…' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/^Automatic · .* · starting$/)).toBeTruthy()
  })
})
