// @vitest-environment happy-dom
import { useState } from 'react'
import type { OrgChartPerson } from '../../../../shared/console-companies-contract'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NextStepOutcomeEditor } from './NextStepOutcomeEditor'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { NextStepAfterSteps } from './NextStepAfterSteps'
import {
  emptyNextStepDraft,
  emptyNextStepOutcomeDraft,
  defaultNextStepInstructions,
  type NextStepDraft
} from '../../../../shared/next-step-draft'

vi.mock('@/components/companies/companies-client', () => ({
  companiesApi: () => ({}),
  companiesErrorMessage: String,
  useCompaniesRead: () => ({ data: { ok: true, user: { employee_id: 'sal' } }, loading: false })
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
const agents = getAgentCatalog().filter((agent) => ['claude', 'codex', 'gemini'].includes(agent.id))
const people = [
  { id: 'sal', name: 'Sal' },
  { id: 'josh', name: 'Josh' }
]
afterEach(cleanup)

function FinishHarness({ orgPeople }: { orgPeople?: readonly OrgChartPerson[] }) {
  const [draft, setDraft] = useState<NextStepDraft>(() => ({
    ...emptyNextStepDraft(),
    outcomes: [
      {
        ...emptyNextStepOutcomeDraft(),
        finish: {
          kind: 'person',
          personId: '',
          personName: '',
          action: 'review',
          disposition: 'ownership'
        }
      }
    ]
  }))
  return (
    <>
      <NextStepOutcomeEditor
        draft={draft}
        agents={agents}
        people={people}
        orgPeople={orgPeople}
        worktreeSelector={null}
        sessionFinish={{ action: 'me', folderId: null }}
        onSessionFinishChange={() => {}}
        onChange={setDraft}
      />
      <output>{JSON.stringify(draft.outcomes?.[0])}</output>
    </>
  )
}
function AfterHarness({ orgPeople }: { orgPeople?: readonly OrgChartPerson[] }) {
  const [draft, setDraft] = useState<NextStepDraft>(() => ({
    ...emptyNextStepDraft(),
    after: [{ kind: 'person' as const, key: 'after', id: '', name: '' }]
  }))
  return (
    <>
      <NextStepAfterSteps
        draft={draft}
        agents={agents}
        people={people}
        orgPeople={orgPeople}
        worktreeSelector="folder"
        parallel={false}
        onChange={(after) => setDraft({ ...draft, after })}
      />
      <output>{JSON.stringify(draft.after)}</output>
    </>
  )
}
const openTeam = (): void => {
  fireEvent.click(screen.getByRole('radio', { name: 'Team' }))
}
const pickerRow = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-next-step-recipient="person:${id}"]`)!

it('After steps defaults to Me and replaces the provisional selection with an explicit person', async () => {
  const { container } = render(<AfterHarness />)
  await waitFor(() =>
    expect(container.querySelector('[data-selected-recipient="sal"]')).toBeTruthy()
  )
  expect(container.querySelector('[data-testid="recipient-human"] img')).toBeNull()
  expect(screen.getByTestId('recipient-category-ai')).toBeTruthy()
  fireEvent.click(screen.getByTestId('recipient-category-people'))
  expect(container.querySelector('[data-selected-recipient]')).toBeNull()
  expect(screen.getByRole('checkbox', { name: 'Sal' }).getAttribute('aria-checked')).toBe('false')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Josh' }))
  await waitFor(() =>
    expect(container.querySelector('[data-selected-recipient="josh"]')).toBeTruthy()
  )
  fireEvent.click(screen.getByTestId('recipient-category-people'))
  expect(screen.getByRole('status').textContent).toContain('josh')
  expect(screen.getByRole('status').textContent).not.toContain('sal')
  expect(screen.getByRole('checkbox', { name: 'Sal' }).getAttribute('aria-checked')).toBe('false')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Sal' }))
  fireEvent.click(screen.getByTestId('recipient-category-people'))
  expect(container.querySelector('[data-selected-recipient="sal"]')).toBeTruthy()
  expect(container.querySelectorAll('[data-selected-recipient]')).toHaveLength(1)
})

it('Next Person names nobody until a chip is clicked, and one click swaps the person', () => {
  render(<FinishHarness />)
  expect(document.querySelector('[data-selected-recipient]')).toBeNull()
  expect(document.querySelector('[data-next-step-summary="finish"]')!.textContent).toBe(
    'Choose a teammate'
  )
  // Why: a Team finish names a person; agents belong to the Agents section.
  expect(screen.queryByTestId('recipient-category-ai')).toBeNull()
  openTeam()
  expect(screen.getByRole('button', { name: 'Sal' }).getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(screen.getByRole('button', { name: 'Josh' }))
  expect(document.querySelector('[data-selected-recipient="josh"]')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toContain('josh')
  expect(screen.getByRole('status').textContent).not.toContain('"sal"')
  // Why: the chosen chip reopens the picker, where Josh now reads as selected.
  fireEvent.click(screen.getByRole('button', { name: /^Josh/ }))
  expect(pickerRow('josh').getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(pickerRow('sal'))
  expect(document.querySelector('[data-selected-recipient="sal"]')).toBeTruthy()
  expect(document.querySelectorAll('[data-selected-recipient]')).toHaveLength(1)
})

it('keeps the Team finish a person finish: picking a teammate never adds an agent step', () => {
  render(<FinishHarness />)
  expect(screen.getByRole('radio', { name: 'Team' }).getAttribute('aria-checked')).toBe('true')
  openTeam()
  fireEvent.click(screen.getByRole('button', { name: 'Sal' }))
  const outcome = JSON.parse(screen.getByRole('status').textContent!)
  expect(outcome.finish).toMatchObject({ kind: 'person', personId: 'sal', personName: 'Sal' })
  expect(outcome.steps).toEqual([])
  expect(screen.getByRole('radio', { name: 'Team' }).getAttribute('aria-checked')).toBe('true')
})

function pickAI(name = 'Claude') {
  fireEvent.click(screen.getByTestId('recipient-category-ai'))
  fireEvent.click(screen.getByRole('checkbox', { name }))
}

const photoUrl = 'https://example.com/josh.jpg'

it('After steps threads photos to roster rows and selected chips with an initials fallback', async () => {
  const { container } = render(<AfterHarness orgPeople={[{ id: 'josh', photo_url: photoUrl }]} />)
  await waitFor(() =>
    expect(container.querySelector('[data-selected-recipient="sal"]')).toBeTruthy()
  )
  expect(container.querySelector('[data-selected-recipient="sal"] img')).toBeNull()
  fireEvent.click(screen.getByTestId('recipient-category-people'))
  expect(
    screen.getByRole('checkbox', { name: 'Josh' }).querySelector('img')?.getAttribute('src')
  ).toBe(photoUrl)
  expect(screen.getByRole('checkbox', { name: 'Sal' }).querySelector('img')).toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Josh' }))
  await waitFor(() =>
    expect(
      container.querySelector('[data-selected-recipient="josh"] img')?.getAttribute('src')
    ).toBe(photoUrl)
  )
})

it('Next Person threads photos to the chips and the chosen chip, with an initials fallback', () => {
  render(<FinishHarness orgPeople={[{ id: 'josh', photo_url: photoUrl }]} />)
  openTeam()
  expect(
    screen.getByRole('button', { name: 'Josh' }).querySelector('img')?.getAttribute('src')
  ).toBe(photoUrl)
  expect(screen.getByRole('button', { name: 'Sal' }).querySelector('img')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Josh' }))
  expect(document.querySelector('[data-selected-recipient="josh"] img')?.getAttribute('src')).toBe(
    photoUrl
  )
  fireEvent.click(screen.getByRole('button', { name: /^Josh/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Sal' }))
  expect(document.querySelector('[data-selected-recipient="sal"] img')).toBeNull()
  expect(document.querySelector('[data-selected-recipient="sal"]')!.textContent).toContain('S')
})

it('replaces the person after-step with an editable agent step at the same key', () => {
  render(<AfterHarness />)
  pickAI()
  const after = JSON.parse(screen.getByRole('status').textContent!)
  expect(after).toEqual([
    {
      kind: 'agent',
      key: 'after',
      actor: { agent: 'claude' },
      presetId: 'implement',
      instructions: defaultNextStepInstructions('implement'),
      rounds: 1
    }
  ])
  expect(after[0]).not.toHaveProperty('id')
  expect(after[0]).not.toHaveProperty('personId')
  expect(screen.queryByText('Send to a person')).toBeNull()
  expect(screen.getByRole('textbox')).toBeTruthy()
})
