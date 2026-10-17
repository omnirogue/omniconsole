// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NextStepFolderPickButton } from './NextStepFolderPickButton'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (message, [key, value]) => message.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))
vi.mock('@/components/sidebar/RemoteFileBrowser', () => ({
  RemoteFileBrowser: ({
    targetId,
    runtimeEnvironmentId,
    onSelect,
    onCancel
  }: {
    targetId?: string
    runtimeEnvironmentId?: string
    onSelect: (path: string) => void
    onCancel: () => void
  }) => (
    <div
      data-testid="remote-file-browser"
      data-target={targetId ?? ''}
      data-runtime={runtimeEnvironmentId ?? ''}
    >
      <button type="button" onClick={() => onSelect('/remote/picked-folder')}>
        Select remote folder
      </button>
      <button type="button" onClick={onCancel}>
        Cancel browse
      </button>
    </div>
  )
}))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>
}))
afterEach(cleanup)
beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { shell: { pickDirectory: vi.fn() } }
  })
})

it('opens the native chooser on this computer and reports only a real pick', async () => {
  const onPick = vi.fn()
  const pickDirectory = vi.mocked(window.api.shell.pickDirectory)
  render(
    <NextStepFolderPickButton
      hostId="local"
      currentFolder="/Users/maintainer/work"
      onPick={onPick}
    />
  )
  pickDirectory.mockResolvedValueOnce('/Users/maintainer/picked')
  fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
  expect(pickDirectory).toHaveBeenCalledWith({ defaultPath: '/Users/maintainer/work' })
  await Promise.resolve()
  expect(onPick).toHaveBeenCalledWith('/Users/maintainer/picked')
  onPick.mockClear()
  pickDirectory.mockResolvedValueOnce(null)
  fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
  await Promise.resolve()
  expect(onPick).not.toHaveBeenCalled()
})

it('browses the host itself over SSH or a runtime, as a dialog', () => {
  const onPick = vi.fn()
  const { rerender } = render(
    <NextStepFolderPickButton hostId="ssh:my-ssh-server" currentFolder="/work" onPick={onPick} />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
  const remote = screen.getByTestId('remote-file-browser')
  expect(remote.getAttribute('data-target')).toBe('my-ssh-server')
  expect(remote.getAttribute('data-runtime')).toBe('')
  fireEvent.click(screen.getByRole('button', { name: 'Select remote folder' }))
  expect(onPick).toHaveBeenCalledWith('/remote/picked-folder')
  expect(screen.queryByTestId('remote-file-browser')).toBeNull()
  onPick.mockClear()
  rerender(
    <NextStepFolderPickButton
      hostId="runtime:my-runtime-env"
      currentFolder="/work"
      onPick={onPick}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
  expect(screen.getByTestId('remote-file-browser').getAttribute('data-runtime')).toBe(
    'my-runtime-env'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Cancel browse' }))
  expect(onPick).not.toHaveBeenCalled()
  expect(screen.queryByTestId('remote-file-browser')).toBeNull()
})

it('says when the host cannot be reached at all', () => {
  render(<NextStepFolderPickButton hostId="nonsense" currentFolder="/work" onPick={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
  expect(screen.getByRole('alert').textContent).toBe('The session execution host is unavailable.')
})
