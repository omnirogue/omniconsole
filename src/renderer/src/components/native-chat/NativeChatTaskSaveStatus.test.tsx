// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatTaskSaveStatus } from './NativeChatTaskSaveStatus'
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
afterEach(cleanup)
describe('task note save indicator', () => {
  it('does not invent a save status for an older host', () => {
    render(<NativeChatTaskSaveStatus />)
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('replaces historical shared confirmation when a new write fails', () => {
    const { rerender } = render(
      <NativeChatTaskSaveStatus status={{ taskId: 'btk_1234', state: 'shared' }} />
    )
    expect(screen.getByRole('status').textContent).toBe('Last task note shared')
    rerender(<NativeChatTaskSaveStatus status={{ taskId: 'btk_1234', state: 'attention' }} />)
    expect(screen.getByRole('status').textContent).toBe('Task note could not be saved')
    rerender(<NativeChatTaskSaveStatus status={{ taskId: 'btk_1234', state: 'pending' }} />)
    expect(screen.getByRole('status').textContent).toBe('Task note saved · Waiting to sync')
  })
})
