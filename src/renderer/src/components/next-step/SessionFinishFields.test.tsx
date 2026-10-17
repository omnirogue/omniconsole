// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SessionFinishFields, sessionFinishActionLabel } from './SessionFinishFields'
import { useSessionFolders } from '@/store/session-folders'
import {
  emptySessionFolderMetadata,
  SAVED_SESSIONS_FOLDER_ID,
  type SessionFinishAction
} from '@/lib/session-folders'
afterEach(cleanup)
beforeEach(() =>
  useSessionFolders.setState({ metadata: emptySessionFolderMetadata(), loaded: true, error: null })
)
function Form() {
  const [value, onChange] = useState<SessionFinishAction>({
    action: 'me',
    folderId: SAVED_SESSIONS_FOLDER_ID
  })
  return <SessionFinishFields value={value} onChange={onChange} />
}
it('starts at Complete and only exposes a folder chooser for Save session', () => {
  render(<Form />)
  expect(screen.getByText('When done')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Complete' }).getAttribute('aria-pressed')).toBe('true')
  expect(
    screen.getByText('Complete — this session moves to Done and stays available.')
  ).toBeTruthy()
  expect(screen.queryByRole('combobox')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Save session' }))
  expect(screen.getByRole('combobox', { name: 'Saved session folder' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'New folder' })).toBeTruthy()
  expect(screen.getByText('Save session — kept under Saved Sessions to reopen later.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'End session' }))
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(
    screen.getByText('End session — the tab closes; its history stays in Recently closed.')
  ).toBeTruthy()
})
it('names each choice the same way everywhere it is shown', () => {
  expect(sessionFinishActionLabel('me')).toBe('Complete')
  expect(sessionFinishActionLabel('end')).toBe('End session')
  expect(sessionFinishActionLabel('save')).toBe('Save session')
})
it('reads as one line in the Next actions row layout, with the hint only for hover and focus', () => {
  const Row = () => {
    const [value, onChange] = useState<SessionFinishAction>({ action: 'me', folderId: null })
    return <SessionFinishFields value={value} onChange={onChange} layout="row" />
  }
  render(<Row />)
  expect(document.querySelector('[data-next-step-summary="once-done"]')!.textContent).toBe(
    'Complete'
  )
  const hint = document.querySelector('[data-next-step-hint="once-done"]')!
  expect(hint.textContent).toBe('Complete — this session moves to Done and stays available.')
  expect(hint.className).toContain('opacity-0')
  expect(hint.className).toContain('group-hover/row:opacity-100')
  expect(screen.getByRole('group', { name: 'Session finish' }).children).toHaveLength(3)
  fireEvent.click(screen.getByRole('button', { name: 'Save session' }))
  expect(document.querySelector('[data-next-step-summary="once-done"]')!.textContent).toBe(
    'Save session'
  )
  expect(screen.getByRole('combobox', { name: 'Saved session folder' })).toBeTruthy()
})
