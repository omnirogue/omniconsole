// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RoutineConversationResultPanel } from './RoutineConversationResultPanel'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
afterEach(cleanup)

it('starts collapsed and preserves an in-progress result interaction when folded', () => {
  render(
    <>
      <RoutineConversationResultPanel>
        <label>
          Decision note
          <input />
        </label>
      </RoutineConversationResultPanel>
      <label>
        Conversation
        <textarea />
      </label>
    </>
  )
  const toggle = screen.getByRole('button', { name: 'Run results' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('textbox', { name: 'Decision note' })).toBeNull()
  const conversation = screen.getByRole('textbox', { name: 'Conversation' })
  fireEvent.change(conversation, { target: { value: 'Explain the recommendation.' } })

  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  const note = screen.getByRole('textbox', { name: 'Decision note' }) as HTMLInputElement
  fireEvent.change(note, { target: { value: 'Check this first.' } })
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(toggle)
  expect(screen.getByRole('textbox', { name: 'Decision note' })).toBe(note)
  expect(note.value).toBe('Check this first.')
  expect((conversation as HTMLTextAreaElement).value).toBe('Explain the recommendation.')
})
