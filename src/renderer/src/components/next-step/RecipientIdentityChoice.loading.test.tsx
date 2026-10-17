// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TeamRosterPerson } from '../../../../shared/team-roster-search'
import { emptyNextStepDraft, emptyNextStepOutcomeDraft } from '../../../../shared/next-step-draft'
import type { NextStepDraft } from '../../../../shared/next-step-draft'
import type { NextStepLoad } from './use-next-step-recipients'
import { NextStepOutcomeEditor } from './NextStepOutcomeEditor'

vi.mock('@/components/companies/companies-client', () => ({
  companiesApi: () => ({}),
  companiesErrorMessage: String,
  useCompaniesRead: () => ({ data: { ok: true, user: { employee_id: 'emp_sal' } }, loading: false })
}))
vi.mock('@/components/build-review/BuildReviewAgentFields', () => ({
  BuildReviewModelEffortFields: () => null,
  CatalogModelEffortFields: () => null
}))
vi.mock('@/components/build-review/BuildReviewReviewerSettings', () => ({
  BuildReviewReviewerSettings: () => null
}))
vi.mock('./SessionFinishFields', () => ({ SessionFinishFields: () => null }))
vi.mock('@/components/agent/AgentAccountSelect', () => ({ AgentAccountSelect: () => null }))
afterEach(cleanup)

function Harness({
  people,
  reload
}: {
  people: NextStepLoad<TeamRosterPerson[]>
  reload: () => void
}) {
  const [draft, setDraft] = useState<NextStepDraft>(() => ({
    ...emptyNextStepDraft(),
    outcomes: [
      {
        ...emptyNextStepOutcomeDraft(),
        finish: {
          kind: 'person' as const,
          personId: '',
          personName: '',
          action: 'review' as const,
          disposition: 'ownership' as const
        }
      }
    ]
  }))
  return (
    <NextStepOutcomeEditor
      draft={draft}
      agents={[]}
      people={people.phase === 'ready' ? people.value : []}
      recipientSource={{ people, reload }}
      worktreeSelector={null}
      sessionFinish={{ action: 'me', folderId: null }}
      onSessionFinishChange={() => {}}
      onChange={setDraft}
    />
  )
}
const openTeam = (): void => {
  fireEvent.click(screen.getByRole('radio', { name: 'Team' }))
}

it('keeps loading and errors in the Team picker, retries, and shows the roster with photos', () => {
  const reload = vi.fn()
  const { rerender } = render(<Harness people={{ phase: 'loading' }} reload={reload} />)
  openTeam()
  expect(screen.getByText('Loading teammates…')).toBeTruthy()
  expect(screen.queryByText('No active teammate matches.')).toBeNull()
  rerender(
    <Harness
      people={{ phase: 'error', message: 'Your team could not be loaded.' }}
      reload={reload}
    />
  )
  expect(screen.getByText('Your team could not be loaded.')).toBeTruthy()
  expect(screen.queryByText('No active teammate matches.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(reload).toHaveBeenCalledOnce()
  rerender(
    <Harness
      people={{
        phase: 'ready',
        value: [
          { id: 'emp_josh', name: 'Josh', photo_url: 'https://example.com/josh.jpg' },
          { id: 'emp_sal', name: 'Sal' }
        ]
      }}
      reload={reload}
    />
  )
  const josh = screen.getByRole('button', { name: 'Josh' })
  expect(josh.querySelector('img')?.getAttribute('src')).toBe('https://example.com/josh.jpg')
  expect(screen.getByRole('button', { name: 'Sal' }).querySelector('img')).toBeNull()
  // Why: two teammates need no search box; the chips are the whole picker.
  expect(screen.queryByRole('textbox', { name: 'Find a teammate…' })).toBeNull()
})

it('offers refresh for an empty account roster without calling it a failed search', () => {
  const reload = vi.fn()
  render(<Harness people={{ phase: 'ready', value: [] }} reload={reload} />)
  openTeam()
  expect(screen.getByText('No teammates are available for your account.')).toBeTruthy()
  reload.mockClear()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh people' }))
  expect(reload).toHaveBeenCalledOnce()
})
