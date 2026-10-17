// @vitest-environment happy-dom
/**
 * The optional Due on a Person block: a date alone is the end of that local day, a time names
 * the minute, it can be cleared, and a moment already past is refused inline without sending.
 * It sits under Note on "Send to a person", ticked or not, reaches the row as a chip, and the
 * block offers no communication type.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { upNextDueAt, upNextDueLabel } from '../../../../shared/up-next-person-due'
import type { UpNextPersonBlock, UpNextView } from '../../../../shared/up-next-types'
import { PersonDueField } from './PersonDueField'
import { PersonBlock } from './blocks/PersonBlock'
import { UpNextChips } from './up-next-chips'
import { upNextFixture } from './up-next-fixture'
import type { UpNextController } from './use-up-next'

vi.mock('@/components/next-step/use-handoff-people', () => ({
  useHandoffPeople: () => ({ people: { phase: 'ready', value: [] }, reload: vi.fn() })
}))
afterEach(cleanup)

const PAST_MESSAGE = 'That due date has passed. Choose a later date or time.'
const dateInput = () => screen.getByLabelText('Due (optional)')
const timeInput = () => screen.getByLabelText('Due time (optional)')

describe('PersonDueField', () => {
  const onChange = vi.fn()
  beforeEach(() => onChange.mockClear())

  it('stores a date alone as the end of that local day', () => {
    render(<PersonDueField value={undefined} onChange={onChange} />)
    fireEvent.change(dateInput(), { target: { value: '2099-09-20' } })
    expect(onChange).toHaveBeenLastCalledWith(upNextDueAt('2099-09-20'))
    expect(screen.getByText('Due at the end of that day.')).toBeTruthy()
  })

  it('adds the time once the person leaves the time field', () => {
    render(<PersonDueField value={upNextDueAt('2099-09-20')!} onChange={onChange} />)
    fireEvent.change(timeInput(), { target: { value: '15:30' } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.blur(timeInput())
    expect(onChange).toHaveBeenLastCalledWith(upNextDueAt('2099-09-20', '15:30'))
  })

  it('refuses a date that has passed, inline, and sends nothing', () => {
    render(<PersonDueField value={undefined} onChange={onChange} />)
    fireEvent.change(dateInput(), { target: { value: '2020-01-01' } })
    expect(screen.getByRole('alert').textContent).toBe(PAST_MESSAGE)
    expect(dateInput().getAttribute('aria-invalid')).toBe('true')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('clears a stored due', () => {
    render(<PersonDueField value={upNextDueAt('2099-09-20')!} onChange={onChange} />)
    expect((dateInput() as HTMLInputElement).value).toBe('2099-09-20')
    fireEvent.click(screen.getByRole('button', { name: 'Clear due date' }))
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })

  it('offers no clear and asks no time while there is no date', () => {
    render(<PersonDueField value={undefined} onChange={onChange} />)
    expect(screen.queryByRole('button', { name: 'Clear due date' })).toBeNull()
    expect((timeInput() as HTMLInputElement).disabled).toBe(true)
  })
})

describe('the Due on a Person block', () => {
  const update = vi.fn(async () => true)
  const controller = { update, disabled: false } as unknown as UpNextController
  beforeEach(() => update.mockClear())

  /** A composed send: the only kind whose form is open for editing. */
  function block(patch: Partial<UpNextPersonBlock> = {}): UpNextPersonBlock {
    const found = upNextFixture('review').blocks.find((entry) => entry.kind === 'person')
    if (found?.kind !== 'person') {
      throw new Error('Person fixture missing')
    }
    return { ...found, id: 'person', state: 'draft', ...patch }
  }
  const view = (person: UpNextPersonBlock): UpNextView => ({
    ...upNextFixture('busy'),
    blocks: [person]
  })

  it.each(['handoff', 'review'] as const)(
    'is offered on %s under the note and sends the due with everything else',
    (relationship) => {
      const person = block({
        relationship,
        receive: { files: true, transcript: true, createTaskCard: false }
      })
      render(<PersonBlock block={person} view={view(person)} controller={controller} />)
      expect(screen.getByLabelText('Note')).toBeTruthy()
      fireEvent.change(dateInput(), { target: { value: '2099-09-20' } })
      expect(update).toHaveBeenLastCalledWith('person', {
        kind: 'person',
        receive: {
          files: true,
          transcript: true,
          createTaskCard: false,
          dueAt: upNextDueAt('2099-09-20')
        }
      })
    }
  )

  it('clears the due, keeps every other receive field and sends everything', () => {
    const person = block({
      relationship: 'handoff',
      receive: {
        files: false,
        transcript: false,
        createTaskCard: true,
        note: 'Ship it.',
        dueAt: upNextDueAt('2099-09-20')!
      }
    })
    render(<PersonBlock block={person} view={view(person)} controller={controller} />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear due date' }))
    expect(update).toHaveBeenLastCalledWith('person', {
      kind: 'person',
      receive: { files: true, transcript: true, createTaskCard: true, note: 'Ship it.' }
    })
  })

  it('never asks for a communication type', () => {
    for (const relationship of ['handoff', 'review'] as const) {
      const person = block({ relationship })
      render(<PersonBlock block={person} view={view(person)} controller={controller} />)
      expect(screen.queryByLabelText('Communication type')).toBeNull()
      expect(screen.queryByText('Communication type')).toBeNull()
      cleanup()
    }
  })

  it('shows a short "due" chip on the Person row', () => {
    const dueAt = upNextDueAt('2099-09-20')!
    render(
      <UpNextChips
        block={block({ receive: { files: true, transcript: false, createTaskCard: false, dueAt } })}
      />
    )
    expect(screen.getByText(`due ${upNextDueLabel(dueAt)}`)).toBeTruthy()
  })
})
