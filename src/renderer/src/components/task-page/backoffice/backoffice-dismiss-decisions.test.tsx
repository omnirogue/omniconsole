// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type * as WorkflowClient from '@/lib/console-workflow-client'
import { DismissDecisionsButton, dismissBreakdown } from './backoffice-dismiss-decisions'

const dismiss = vi.fn()
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/console-workflow-client', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkflowClient>()
  return { ...actual, consoleWorkflowApi: () => ({ dismissMachineDecisions: dismiss }) }
})

afterEach(() => {
  cleanup()
  dismiss.mockReset()
})

describe('DismissDecisionsButton', () => {
  it('counts first, then dismisses only after the person confirms the number', async () => {
    dismiss
      .mockResolvedValueOnce({
        ok: true,
        data: {
          matched: 3,
          dismissed: 0,
          by_class: { stale_send: 2, crashed_reconcile: 1 },
          dry_run: true
        }
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          matched: 3,
          dismissed: 3,
          by_class: { stale_send: 2, crashed_reconcile: 1 },
          dry_run: false
        }
      })
    const onDismissed = vi.fn()
    render(
      <TooltipProvider>
        <DismissDecisionsButton onDismissed={onDismissed} />
      </TooltipProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss decisions' }))
    await waitFor(() =>
      expect(screen.getByText('Dismiss 3 machine-generated decisions?')).toBeTruthy()
    )
    expect(screen.getByText('2 stale send, 1 crashed reconcile')).toBeTruthy()
    expect(dismiss).toHaveBeenCalledWith({ dryRun: true })
    expect(onDismissed).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(onDismissed).toHaveBeenCalledTimes(1))
    expect(dismiss).toHaveBeenLastCalledWith({ dryRun: false })
  })

  it('says so when nothing is machine-generated, and never dismisses', async () => {
    dismiss.mockResolvedValueOnce({
      ok: true,
      data: { matched: 0, dismissed: 0, by_class: {}, dry_run: true }
    })
    render(
      <TooltipProvider>
        <DismissDecisionsButton onDismissed={vi.fn()} />
      </TooltipProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss decisions' }))
    await waitFor(() => expect(screen.getByText(/Nothing to dismiss/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
    expect(dismiss).toHaveBeenCalledTimes(1)
  })

  it('reads the hub classes as words', () => {
    expect(
      dismissBreakdown({
        matched: 2,
        dismissed: 0,
        by_class: { stale_send: 2, other: 0 },
        dry_run: true
      })
    ).toBe('2 stale send')
  })
})
