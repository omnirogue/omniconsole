// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InboxContextUpdate } from './InboxContextUpdate'
import { decodeRoomRecord } from './inbox-room-record'
vi.mock('@/components/sidebar/session-folders/use-sidebar-sessions', () => ({
  useSidebarSessions: () => []
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(cleanup)

function setup(sourcePostId?: string) {
  const prepare = vi.fn()
  render(
    <InboxContextUpdate
      project="proj_one"
      roomId="room_one"
      sourcePostId={sourcePostId}
      close={vi.fn()}
      prepare={prepare}
    />
  )
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Progress update' } })
  fireEvent.change(screen.getByLabelText('Current progress'), {
    target: { value: 'Callback cause identified.' }
  })
  return prepare
}
function sentRecord(prepare: ReturnType<typeof vi.fn>) {
  const instruction = prepare.mock.calls[0][0] as string
  const start = instruction.indexOf('\n\n{') + 2
  const end = instruction.indexOf('\n}\n\n', start) + 2
  const body = JSON.parse(instruction.slice(start, end))
  return { instruction, body, record: decodeRoomRecord(body.summary) }
}
it('requires confirmation after exact public preview and preserves the edit boundary', () => {
  const prepare = setup()
  fireEvent.change(screen.getByLabelText('Public excerpt (up to 800 characters)'), {
    target: { value: 'AI: Approved excerpt only.' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Preview shared update' }))
  expect(prepare).not.toHaveBeenCalled()
  expect(
    screen.getByText(/Selected session excerpt: AI: Approved excerpt only/)
  ).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }))
  expect(screen.getByLabelText('Public excerpt (up to 800 characters)')).toHaveValue(
    'AI: Approved excerpt only.'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Preview shared update' }))
  fireEvent.click(screen.getByRole('button', { name: 'Choose my AI' }))
  expect(prepare).toHaveBeenCalledTimes(1)
  const { instruction, body, record } = sentRecord(prepare)
  expect(body.room_id).toBe('room_one')
  expect(record?.body).toContain('AI: Approved excerpt only.')
  expect(instruction).toContain('Share only the exact reviewed summary')
  expect(instruction).not.toContain('transcriptPath')
})
it('keeps revisions append-only and requires own-author same-room verification', () => {
  const prepare = setup('post_previous')
  fireEvent.click(screen.getByRole('button', { name: 'Preview shared update' }))
  expect(screen.getByText(/Earlier content remains in history/)).toBeInTheDocument()
  expect(prepare).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Choose my AI' }))
  const { instruction, record } = sentRecord(prepare)
  expect(record?.supersedes_message_id).toBe('post_previous')
  expect(record?.source_message_ids).toEqual(['post_previous'])
  expect(instruction).toContain(
    'belongs to this room and was authored by your own employee identity'
  )
  expect(instruction).toContain('append-only update, not deletion')
})
it('allows valid HTTPS links with trailing blank lines but blocks credential-bearing links', () => {
  const prepare = setup()
  fireEvent.change(
    screen.getByLabelText('File or PR links (one HTTPS link per line, up to four)'),
    { target: { value: 'https://example.com/evidence\n\n' } }
  )
  fireEvent.click(screen.getByRole('button', { name: 'Preview shared update' }))
  expect(screen.getByRole('button', { name: 'Choose my AI' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }))
  fireEvent.change(
    screen.getByLabelText('File or PR links (one HTTPS link per line, up to four)'),
    { target: { value: 'https://person:secret@example.com/evidence' } }
  )
  fireEvent.click(screen.getByRole('button', { name: 'Preview shared update' }))
  expect(screen.getByRole('alert')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Choose my AI' })).not.toBeInTheDocument()
  expect(prepare).not.toHaveBeenCalled()
})
