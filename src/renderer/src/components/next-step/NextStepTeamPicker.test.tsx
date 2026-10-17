// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TeamRosterPerson } from '../../../../shared/team-roster-search'
import { NextStepTeamPicker } from './NextStepTeamPicker'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))
vi.mock('./NextStepAgentRecipientChoice', () => ({
  NextStepAgentRecipientChoice: () => (
    <button type="button">Choose an existing employee agent</button>
  )
}))
afterEach(cleanup)

const people: TeamRosterPerson[] = [
  { id: 'josh', name: 'Josh', role: 'Designer', photo_url: 'https://example.test/josh.png' },
  { id: 'eve', name: 'Eve Barnett' }
] as TeamRosterPerson[]

it('lists teammates as chips with their photo, and one click chooses', () => {
  const onSelect = vi.fn()
  render(
    <NextStepTeamPicker
      people={{ phase: 'ready', value: people }}
      selectedId="eve"
      onSelect={onSelect}
      onRetry={() => {}}
      onAgentRecipient={() => {}}
    />
  )
  // Why: the row reads photo, name, then the muted role — so its name carries the role too.
  const josh = screen.getByRole('button', { name: 'Josh Designer' })
  expect(josh.querySelector('img')?.getAttribute('src')).toBe('https://example.test/josh.png')
  expect(josh.textContent).toContain('Designer')
  expect(screen.getByRole('button', { name: 'Eve Barnett' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  expect(screen.queryByRole('textbox')).toBeNull()
  fireEvent.click(josh)
  expect(onSelect).toHaveBeenCalledWith(people[0])
  expect(screen.getByRole('button', { name: 'Choose an existing employee agent' })).toBeTruthy()
})

it('adds a search box only for a large team and filters the chips by it', () => {
  const many = Array.from({ length: 9 }, (_, index) => ({
    id: `p${index}`,
    name: `Person ${index}`
  })) as TeamRosterPerson[]
  render(
    <NextStepTeamPicker
      people={{ phase: 'ready', value: many }}
      selectedId={null}
      onSelect={() => {}}
      onRetry={() => {}}
      onAgentRecipient={() => {}}
    />
  )
  fireEvent.change(screen.getByRole('textbox', { name: 'Find a teammate…' }), {
    target: { value: 'Person 7' }
  })
  expect(screen.getAllByRole('button', { name: /^Person/ })).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Person 7' })).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: 'Find a teammate…' }), {
    target: { value: 'zzz' }
  })
  expect(screen.getByText('No active teammate matches.')).toBeTruthy()
})

it('shows loading, an error with retry, and an empty roster with refresh', () => {
  const onRetry = vi.fn()
  const { rerender } = render(
    <NextStepTeamPicker
      people={{ phase: 'loading' }}
      selectedId={null}
      onSelect={() => {}}
      onRetry={onRetry}
      onAgentRecipient={() => {}}
    />
  )
  expect(screen.getByText('Loading teammates…')).toBeTruthy()
  rerender(
    <NextStepTeamPicker
      people={{ phase: 'error', message: 'Roster offline' }}
      selectedId={null}
      onSelect={() => {}}
      onRetry={onRetry}
      onAgentRecipient={() => {}}
    />
  )
  expect(screen.getByText('Roster offline')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(onRetry).toHaveBeenCalledTimes(1)
  rerender(
    <NextStepTeamPicker
      people={{ phase: 'ready', value: [] }}
      selectedId={null}
      onSelect={() => {}}
      onRetry={onRetry}
      onAgentRecipient={() => {}}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Refresh people' }))
  expect(onRetry).toHaveBeenCalledTimes(2)
})
