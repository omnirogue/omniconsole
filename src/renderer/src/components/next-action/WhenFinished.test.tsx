// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { upNextBlockPatchSchema } from '../../../../shared/up-next-draft-schema'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WhenFinished } from './WhenFinished'
import {
  sessionFinishActionFrom,
  whenFinishedFrom,
  type WhenFinishedValue
} from './when-finished-value'
import { useSessionFolders } from '@/store/session-folders'
import { emptySessionFolderMetadata } from '@/lib/session-folders'

afterEach(cleanup)
beforeEach(() =>
  useSessionFolders.setState({
    metadata: emptySessionFolderMetadata(),
    loaded: true,
    error: null
  })
)

function Block({ initial }: { initial?: WhenFinishedValue }): React.JSX.Element {
  const [value, setValue] = useState<WhenFinishedValue>(initial ?? { finish: 'none' })
  return <WhenFinished value={value} onChange={setValue} />
}

it('defaults to Done with both optional actions unselected', () => {
  render(<Block />)
  expect(screen.getByRole('button', { name: 'Close session' }).getAttribute('aria-pressed')).toBe(
    'false'
  )
  expect(document.querySelector('[data-next-action-when-finished-hint]')!.textContent).toBe(
    'No selection: the finished session stays in Done.'
  )
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(screen.queryByRole('button', { name: /Mark.*complete/ })).toBeNull()
  expect(screen.getByRole('group', { name: 'When finished' }).children).toHaveLength(2)
})

it('reveals the existing folder chooser once Save is chosen', () => {
  render(<Block />)
  fireEvent.click(screen.getByRole('button', { name: 'Save session' }))
  expect(document.querySelector('[data-next-action-when-finished-hint]')!.textContent).toBe(
    'Applies after the session and all queued work finish. Click again to clear.'
  )
  expect(screen.getByRole('combobox', { name: 'Saved session folder' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'New folder' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Close session' }))
  expect(screen.queryByRole('combobox')).toBeNull()
})

it('preserves legacy Complete without choosing Close', () => {
  expect(whenFinishedFrom({ action: 'me', folderId: null })).toEqual({
    finish: 'none'
  })
  render(<Block initial={whenFinishedFrom({ action: 'me', folderId: null })} />)
  expect(screen.getByRole('button', { name: 'Close session' }).getAttribute('aria-pressed')).toBe(
    'false'
  )
})

it('maps its two choices onto the finish actions the host still accepts', () => {
  expect(sessionFinishActionFrom({ finish: 'close' })).toEqual({
    action: 'end',
    folderId: null
  })
  expect(sessionFinishActionFrom({ finish: 'save', folderId: 'folder-1' })).toEqual({
    action: 'save',
    folderId: 'folder-1'
  })
  expect(whenFinishedFrom({ action: 'save', folderId: 'folder-1' })).toEqual({
    finish: 'save',
    folderId: 'folder-1'
  })
})

it('strips runtime fields from Save even when its input is a full Done block', () => {
  const onChange = vi.fn()
  const value = {
    kind: 'done' as const,
    id: 'done',
    state: 'draft' as const,
    number: '2',
    locked: false,
    finish: 'close' as const,
    folderId: 'folder-1'
  }
  render(<WhenFinished value={value} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: 'Save session' }))
  expect(onChange).toHaveBeenCalledWith({
    finish: 'save',
    folderId: 'folder-1'
  })
  expect(
    upNextBlockPatchSchema.safeParse({
      kind: 'done',
      ...onChange.mock.calls[0]![0]
    }).success
  ).toBe(true)
})

it('clears either selected option with a second click', () => {
  render(<Block />)
  for (const name of ['Close session', 'Save session']) {
    const button = screen.getByRole('button', { name })
    fireEvent.click(button)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(button)
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByRole('combobox')).toBeNull()
  }
})
