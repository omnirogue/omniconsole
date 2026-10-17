// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CreateTaskDialog } from './CreateTaskDialog'

const fixture = vi.hoisted(() => ({
  settings: { backofficeEnv: 'production', backofficeProductionUrl: 'https://omnios.example.com' },
  openUrl: vi.fn(),
  createTask: vi.fn(),
  bindSession: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) => select({ settings: fixture.settings })
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
beforeEach(() => {
  vi.resetAllMocks()
  fixture.settings.backofficeProductionUrl = 'https://omnios.example.com'
  fixture.openUrl.mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      shell: { openUrl: fixture.openUrl },
      backoffice: { createTask: fixture.createTask },
      consoleWorkflows: { bindSession: fixture.bindSession }
    }
  })
})
afterEach(cleanup)

it('opens the configured Jira capture page without creating or attaching a legacy task', async () => {
  const onOpenChange = vi.fn(),
    onCreated = vi.fn()
  render(<CreateTaskDialog session={null} open onOpenChange={onOpenChange} onCreated={onCreated} />)
  expect(screen.getByText('Tasks now live in Jira')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Open Jira tasks' }))
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  expect(fixture.openUrl).toHaveBeenCalledExactlyOnceWith('https://omnios.example.com/work/jira')
  expect(fixture.createTask).not.toHaveBeenCalled()
  expect(fixture.bindSession).not.toHaveBeenCalled()
  expect(onCreated).not.toHaveBeenCalled()
})

it('refuses an invalid configured origin without using a different account or site', () => {
  fixture.settings.backofficeProductionUrl = 'http://insecure.example.com'
  render(<CreateTaskDialog session={null} open onOpenChange={vi.fn()} />)
  expect(screen.getByRole('button', { name: 'Open Jira tasks' }).hasAttribute('disabled')).toBe(
    true
  )
  expect(screen.getByRole('alert').textContent).toContain('Settings')
  expect(fixture.openUrl).not.toHaveBeenCalled()
})

it('keeps an opening error visible until closed and clears it before reopening', async () => {
  fixture.openUrl.mockRejectedValue(new Error('Browser unavailable'))
  const close = vi.fn()
  const view = render(<CreateTaskDialog session={null} open onOpenChange={close} />)
  fireEvent.click(screen.getByRole('button', { name: 'Open Jira tasks' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Browser unavailable')
  expect(close).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  view.rerender(<CreateTaskDialog session={null} open={false} onOpenChange={close} />)
  view.rerender(<CreateTaskDialog session={null} open onOpenChange={close} />)
  expect(screen.queryByRole('alert')).toBeNull()
})

it('does not open anything when cancelled or closed', () => {
  const close = vi.fn()
  const view = render(<CreateTaskDialog session={null} open onOpenChange={close} />)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(close).toHaveBeenCalledWith(false)
  view.rerender(<CreateTaskDialog session={null} open={false} onOpenChange={close} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(fixture.openUrl).not.toHaveBeenCalled()
})
