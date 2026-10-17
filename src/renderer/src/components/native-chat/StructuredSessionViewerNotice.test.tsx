// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
import { StructuredSessionViewerNotice } from './StructuredSessionViewerNotice'
const hold = {
  processState: 'exited' as const,
  fallback: false,
  error: null,
  resume: vi.fn(async () => true),
  refresh: vi.fn()
}
afterEach(cleanup)
describe('viewer state notice', () => {
  it('labels dormant history and starts only when Resume is clicked', async () => {
    hold.resume.mockClear()
    render(<StructuredSessionViewerNotice hold={hold} />)
    expect(screen.getByText('Paused. Resume to continue this conversation.')).toBeTruthy()
    expect(hold.resume).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(hold.resume).toHaveBeenCalledOnce())
  })
  it('labels legacy host fallback', () => {
    render(
      <StructuredSessionViewerNotice
        hold={{ ...hold, fallback: true, processState: 'unverifiable' }}
      />
    )
    expect(screen.getByText(/legacy viewing/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
  })
  it('shows connection errors without treating them as paused', () => {
    render(
      <StructuredSessionViewerNotice
        hold={{ ...hold, processState: 'unverifiable', error: 'owner unreachable' }}
      />
    )
    expect(screen.getByText('owner unreachable')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }))
    expect(hold.refresh).toHaveBeenCalledOnce()
  })
})
