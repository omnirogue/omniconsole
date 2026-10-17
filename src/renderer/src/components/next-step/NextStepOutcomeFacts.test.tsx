// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { NextStepOutcomeDraft } from '../../../../shared/next-step-draft'
import type { NextStepOutcomeFacts as Facts } from './next-step-outcome-facts'

const phase = vi.hoisted(() => ({ agentState: null as string | null, returned: false }))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))
vi.mock('./use-next-step-session-phase', () => ({
  useNextStepSessionPhaseInput: () => phase
}))
vi.mock('./OutcomeResolutionActions', () => ({ OutcomeResolutionActions: () => null }))
vi.mock('./NextStepPlaceSelect', () => ({
  NextStepPlaceSelect: ({ flat }: { flat?: boolean }) => (
    <div data-testid="place-select" data-flat={String(flat)} />
  )
}))
vi.mock('./NextStepOutcomeFiles', () => ({
  NextStepOutcomeFiles: () => <button type="button">Saves to Work/site</button>
}))
vi.mock('@/components/tasks/CreateTaskButton', () => ({
  CreateTaskButton: () => <button type="button">Create task</button>
}))
import { NextStepOutcomeFacts } from './NextStepOutcomeFacts'
afterEach(cleanup)

const facts: Facts = {
  session: {
    rowKey: 'row',
    sessionKey: 'session',
    worktreeId: 'folder:work',
    hostId: 'local',
    tabId: 'tab',
    paneKey: 'tab:pane',
    kind: 'terminal',
    label: 'Landing page copy',
    workspaceLabel: 'Work',
    agent: 'codex',
    unavailable: false,
    folderKeyMigration: null
  },
  workspacePath: '/work/site',
  branch: 'main',
  repoId: 'repo',
  repoName: 'site',
  model: 'gpt-6-astra',
  summary: 'Rewrote the hero and the pricing table. Tests pass.',
  task: null,
  defaultDeliverables: null
}

function Harness({
  task,
  patch,
  instructions = ''
}: {
  task?: { id: string; title: string } | null
  patch?: Partial<Facts>
  instructions?: string
}) {
  const [outcome, setOutcome] = useState<NextStepOutcomeDraft>({
    id: 'o',
    finish: { kind: 'complete' },
    instructions,
    steps: []
  })
  return (
    <>
      <NextStepOutcomeFacts
        facts={{ ...facts, task: task ?? null, ...patch }}
        outcome={outcome}
        onOutcomeChange={setOutcome}
        handoff={{ task: null, deliverables: null, includeSummary: true }}
        onHandoffChange={() => {}}
        chain={null}
        onChainChanged={() => {}}
        onError={() => {}}
      />
      <output>{outcome.instructions}</output>
    </>
  )
}
/** Every text node a sighted reader sees in the facts column, in order. */
function visibleText(): string[] {
  const walker = document.createTreeWalker(
    document.querySelector('[data-next-step-section="details"]')!,
    NodeFilter.SHOW_TEXT
  )
  const texts: string[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim()
    if (text && !node.parentElement?.closest('.sr-only')) {
      texts.push(text)
    }
  }
  return texts
}
const more = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'More' }))
}

it('opens as three lines — session · phase, the folder, the place — and a small More', () => {
  render(<Harness />)
  expect(visibleText()).toEqual(['Landing page copy', '· Idle', 'Saves to Work/site', 'More'])
  expect(screen.getByTestId('place-select').getAttribute('data-flat')).toBe('true')
  // Why: the agent, the repo, the last answer, the notes and the package are not opening facts.
  expect(screen.queryByText('Codex · gpt-6-astra')).toBeNull()
  expect(screen.queryByText(/^Repo ·/)).toBeNull()
  expect(screen.queryByText(/Rewrote the hero/)).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(document.querySelector('[data-next-step-package]')).toBeNull()
})

it('shows the task line instead of the place once a task is linked, and moves the place behind More', () => {
  render(<Harness task={{ id: 'btk_1', title: 'Ship the landing page' }} />)
  expect(screen.getByText('Ship the landing page')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Create task' })).toBeTruthy()
  expect(screen.queryByTestId('place-select')).toBeNull()
  more()
  expect(screen.getByTestId('place-select')).toBeTruthy()
  expect(screen.getAllByRole('button', { name: 'Create task' })).toHaveLength(1)
})

it('keeps agent · model, the repo line and the progress behind More; a folder workspace has no repo line', () => {
  render(<Harness />)
  more()
  expect(screen.getByText('Codex · gpt-6-astra')).toBeTruthy()
  expect(screen.getByText('Repo · site @ main')).toBeTruthy()
  expect(document.querySelector('[data-next-step-status="idle"]')).toBeTruthy()
  expect(screen.getByText('No task')).toBeTruthy()
  cleanup()
  render(<Harness patch={{ repoId: null, repoName: null, branch: null }} />)
  more()
  expect(document.querySelector('[data-next-step-repo]')).toBeNull()
  expect(screen.queryByText(/^Repo ·/)).toBeNull()
})

it('reveals the notes only when asked for, and keeps saved notes in view', () => {
  render(<Harness />)
  more()
  expect(screen.queryByRole('textbox', { name: 'Notes for the agents' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Add a note' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Notes for the agents' }), {
    target: { value: 'Keep the pricing table.' }
  })
  expect(screen.getByRole('status').textContent).toBe('Keep the pricing table.')
  expect(screen.queryByRole('button', { name: 'Add a note' })).toBeNull()
  cleanup()
  render(<Harness instructions="Already written." />)
  more()
  expect(
    (screen.getByRole('textbox', { name: 'Notes for the agents' }) as HTMLTextAreaElement).value
  ).toBe('Already written.')
})

it('names the phase on the first line, in red when the session needs you', () => {
  render(<Harness />)
  expect(document.querySelector('[data-next-step-status="idle"]')).toBeTruthy()
  cleanup()
  phase.agentState = 'blocked'
  render(<Harness />)
  expect(screen.getByText('· Needs you').className).toContain('text-destructive')
  expect(document.querySelector('[data-next-step-status="needs-you"]')).toBeTruthy()
  phase.agentState = null
})
