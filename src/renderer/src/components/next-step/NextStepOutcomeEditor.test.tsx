// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultNextStepInstructions,
  emptyNextStepDraft,
  emptyNextStepOutcomeDraft,
  type NextStepDraft,
  type NextStepOutcomeDraft,
  type NextStepOutcomeStep
} from '../../../../shared/next-step-draft'
import type { ReviewerSeat } from '@/components/build-review/BuildReviewReviewerSettings'
import type { NextStepOutcomeFacts as Facts } from './next-step-outcome-facts'
import { defaultNextStepOutcomeDraft } from './next-step-outcome-sections'
import { actionLabel } from './next-step-summary'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))
vi.mock('@/components/build-review/BuildReviewReviewerSettings', () => ({
  BuildReviewReviewerSettings: ({
    seats,
    onChange,
    maxRounds,
    onRoundsChange,
    maxReviewers,
    maxRoundsLimit
  }: {
    seats: ReviewerSeat[]
    onChange: (seats: ReviewerSeat[]) => void
    maxRounds: number
    onRoundsChange: (rounds: number) => void
    maxReviewers?: number
    maxRoundsLimit?: number
  }) => (
    <div
      data-testid="reviewer-settings"
      data-seats={seats.map((seat) => seat.choice.agent).join(',')}
      data-rounds={maxRounds}
      data-max-reviewers={maxReviewers}
      data-max-rounds={maxRoundsLimit}
    >
      <button
        type="button"
        onClick={() => onChange([...seats, { id: seats.length, choice: { agent: 'grok' } }])}
      >
        Add reviewer
      </button>
      <button type="button" onClick={() => onRoundsChange(9)}>
        Nine rounds
      </button>
    </div>
  )
}))
vi.mock('./NextStepOutcomeHandoffFields', () => ({
  HandoffFields: ({
    step,
    onChange
  }: {
    step: Extract<NextStepOutcomeStep, { kind: 'handoff' }>
    onChange: (step: NextStepOutcomeStep) => void
  }) => (
    <button type="button" onClick={() => onChange({ ...step, presetId: 'research' })}>
      {`preset:${step.presetId}:${step.actor?.agent ?? 'none'}`}
    </button>
  )
}))
vi.mock('./SessionFinishFields', () => ({
  SessionFinishFields: ({ value }: { value: { action: string } }) => (
    <div data-testid="once-done">{value.action}</div>
  )
}))
vi.mock('./NextStepOutcomeFacts', () => ({ NextStepOutcomeFacts: () => null }))
vi.mock('./NextStepOutcomePackage', () => ({
  NEXT_STEP_PACKAGE_MAX_FILES: 4,
  NextStepOutcomePackageLine: ({ teamRecipient }: { teamRecipient?: boolean }) => (
    <div data-testid="package" data-team={String(teamRecipient)} />
  )
}))
const changed = vi.hoisted(() => ({
  detected: null as { paths: string[]; truncated: boolean } | null,
  enabled: [] as boolean[]
}))
vi.mock('./next-step-session-changes', () => ({
  useSessionChangedFiles: (_target: unknown, _limit: number, enabled: boolean) => {
    changed.enabled.push(enabled)
    return { detected: enabled ? changed.detected : null, loading: false, refresh: () => {} }
  },
  mergeSessionFiles: ({ detected, current }: { detected: string[]; current: string[] }) => [
    ...new Set([...detected, ...current])
  ]
}))
const directory = vi.hoisted(() => vi.fn())
vi.mock('@/components/handoffs/handoff-client', () => ({
  handoffApi: () => ({ agentRecipients: directory })
}))
import { NextStepOutcomeEditor } from './NextStepOutcomeEditor'
afterEach(cleanup)

const codex = { id: 'codex', label: 'Codex' } as never
const claude = { id: 'claude', label: 'Claude' } as never
const facts: Facts = {
  session: {
    worktreeId: 'folder:work',
    hostId: 'local',
    paneKey: 'tab:pane',
    label: 'Work'
  } as never,
  workspacePath: '/work',
  branch: null,
  repoId: null,
  repoName: null,
  model: null,
  summary: null,
  task: null,
  defaultDeliverables: null
}
const handoff = (id: string, agent: 'codex' | 'claude' = 'codex'): NextStepOutcomeStep => ({
  id,
  kind: 'handoff',
  actor: { agent },
  presetId: 'implement',
  instructions: `Instruction ${id}`
})
function draftWith(outcomes: NextStepOutcomeDraft[]): NextStepDraft {
  return { ...emptyNextStepDraft(), outcomes }
}
function Harness({
  initial,
  timing,
  onTimingChange
}: {
  initial: NextStepDraft
  timing?: 'now' | 'done'
  onTimingChange?: (timing: 'now' | 'done') => void
}) {
  const [draft, setDraft] = useState(initial)
  return (
    <>
      <NextStepOutcomeEditor
        draft={draft}
        onChange={setDraft}
        agents={[codex, claude]}
        people={[{ id: 'josh', name: 'Josh' }]}
        worktreeSelector="id:work"
        facts={facts}
        sessionFinish={{ action: 'me', folderId: null }}
        onSessionFinishChange={() => {}}
        timing={timing}
        onTimingChange={onTimingChange}
      />
      <output>{JSON.stringify(draft)}</output>
    </>
  )
}
const read = (): NextStepDraft => JSON.parse(screen.getByRole('status').textContent!)
const outcome = (): NextStepOutcomeDraft => read().outcomes![0]!
const agentsSummary = (): string | undefined =>
  document.querySelector('[data-next-step-summary="agents"]')?.textContent ?? undefined
const NONE = 'None'
const rows = (): HTMLElement[] =>
  screen.getAllByRole('button', { name: /^\d+ · (Review|Agent) · / })
const openRow = (number: number): void => {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${number} · `) }))
}
const teamPicker = (): Element | null => document.querySelector('[data-next-step-team-picker]')
async function addAgent(item: RegExp): Promise<void> {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Add agent' }))
  await user.click(screen.getByRole('menuitem', { name: item }))
}
const seed = { agent: 'claude', model: 'opus', effort: 'high' }

describe('the default path', () => {
  it('needs no click: no agents, Me, Complete — and no editors, picker or package in view', () => {
    render(<Harness initial={draftWith([defaultNextStepOutcomeDraft()])} />)
    expect(agentsSummary()).toBe(NONE)
    expect(screen.getByRole('radio', { name: 'Me' }).getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('[data-next-step-summary="finish"]')!.textContent).toBe('Me')
    expect(document.querySelector('[data-next-step-hint="finish"]')!.textContent).toBe(
      'Me — it comes back to you.'
    )
    expect(screen.getByTestId('once-done').textContent).toBe('me')
    expect(outcome().finish).toEqual({ kind: 'complete' })
    expect(outcome().steps).toEqual([])
    expect(teamPicker()).toBeNull()
    expect(screen.queryByTestId('package')).toBeNull()
    expect(screen.queryByTestId('reviewer-settings')).toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByText(/Outcome 1 of/)).toBeNull()
  })

  it('reads an unset finish as Me and writes it on the first edit', async () => {
    render(<Harness initial={draftWith([{ ...emptyNextStepOutcomeDraft(), finish: null }])} />)
    expect(screen.getByRole('radio', { name: 'Me' }).getAttribute('aria-checked')).toBe('true')
    await addAgent(/^Review/)
    fireEvent.click(screen.getByRole('button', { name: 'Remove step' }))
    expect(outcome()).toMatchObject({ finish: { kind: 'complete' }, steps: [] })
    expect(agentsSummary()).toBe(NONE)
  })
})

describe('Add agent ▾ Review', () => {
  it('adds a review as one line; its Build & Review seats open from the line and it can be removed', async () => {
    render(<Harness initial={draftWith([defaultNextStepOutcomeDraft()])} />)
    await addAgent(/^Review/)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(outcome().steps).toEqual([
      {
        id: expect.any(String),
        kind: 'review',
        reviewers: [
          seed,
          { agent: 'codex', model: 'gpt-6-astra' },
          { agent: 'codex', model: 'gpt-6.1-sol' }
        ],
        maxRounds: 3,
        repairWithSource: true,
        instructions: '',
        adversarial: false
      }
    ])
    expect(agentsSummary()).toBe('1 step')
    expect(rows().map((row) => row.textContent)).toEqual([
      '1 · Review · Claude opus high, Codex gpt-6-astra, Codex gpt-6.1-sol · 3 rounds · Original builder repairs'
    ])
    expect(screen.queryByTestId('reviewer-settings')).toBeNull()
    openRow(1)
    const settings = screen.getByTestId('reviewer-settings')
    expect(settings.getAttribute('data-max-reviewers')).toBe('5')
    expect(settings.getAttribute('data-max-rounds')).toBe('5')
    fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }))
    expect(screen.getByTestId('reviewer-settings').getAttribute('data-seats')).toBe(
      'claude,codex,codex,grok'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Nine rounds' }))
    expect(screen.getByTestId('reviewer-settings').getAttribute('data-rounds')).toBe('5')
    fireEvent.change(screen.getByRole('textbox', { name: 'Review focus (optional)' }), {
      target: { value: 'Break it.' }
    })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Adversarial scrutiny' }))
    expect(outcome().steps[0]).toMatchObject({
      reviewers: [
        seed,
        { agent: 'codex', model: 'gpt-6-astra' },
        { agent: 'codex', model: 'gpt-6.1-sol' },
        { agent: 'grok' }
      ],
      maxRounds: 5,
      repairWithSource: true,
      instructions: 'Break it.',
      adversarial: true
    })
    expect(rows()[0]!.textContent).toBe(
      '1 · Review · Claude opus high, Codex gpt-6-astra, Codex gpt-6.1-sol, Grok · 5 rounds · Adversarial · Original builder repairs'
    )
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Repair findings with the original builder' })
    )
    expect(outcome().steps[0]).toMatchObject({ maxRounds: 5, repairWithSource: false })
    fireEvent.click(screen.getByRole('button', { name: 'Remove step' }))
    expect(outcome().steps).toEqual([])
    expect(agentsSummary()).toBe(NONE)
  })

  it('appends after the agents already listed and avoids the producer’s own model', async () => {
    render(
      <Harness
        initial={draftWith([{ ...defaultNextStepOutcomeDraft(), steps: [handoff('a', 'codex')] }])}
      />
    )
    await addAgent(/^Review/)
    expect(outcome().steps.map((step) => step.kind)).toEqual(['handoff', 'review'])
    // Three distinct models by default, none of them the producer's own (codex · Astra).
    expect((outcome().steps[1] as { reviewers: unknown[] }).reviewers).toEqual([
      seed,
      { agent: 'codex', model: 'gpt-6.1-sol' },
      { agent: 'codex', model: 'gpt-5.6-sol' }
    ])
    cleanup()
    const claudeOpus: NextStepOutcomeStep = {
      id: 'a',
      kind: 'handoff',
      actor: { agent: 'claude', model: 'opus' },
      presetId: 'implement',
      instructions: 'Instruction a'
    }
    render(
      <Harness initial={draftWith([{ ...defaultNextStepOutcomeDraft(), steps: [claudeOpus] }])} />
    )
    await addAgent(/^Review/)
    expect((outcome().steps[1] as { reviewers: unknown[] }).reviewers).toEqual([
      { agent: 'codex', model: 'gpt-6-astra' },
      { agent: 'codex', model: 'gpt-6.1-sol' },
      { agent: 'codex', model: 'gpt-5.6-sol' }
    ])
  })
})

describe('Add agent ▾ Agent', () => {
  it('appends sequential agents with default instructions, edits them from their line, reorders and removes', async () => {
    render(<Harness initial={draftWith([defaultNextStepOutcomeDraft()])} />)
    await addAgent(/^Agent/)
    await addAgent(/^Agent/)
    expect(outcome().steps).toEqual([
      {
        id: expect.any(String),
        kind: 'handoff',
        actor: { agent: 'codex', model: 'gpt-6-astra' },
        presetId: 'implement',
        instructions: defaultNextStepInstructions('implement')
      },
      {
        id: expect.any(String),
        kind: 'handoff',
        actor: { agent: 'claude', model: 'opus' },
        presetId: 'implement',
        instructions: defaultNextStepInstructions('implement')
      }
    ])
    const implement = actionLabel('implement')
    expect(agentsSummary()).toBe('2 steps')
    expect(rows().map((row) => row.textContent)).toEqual([
      `1 · Agent · Codex · ${implement}`,
      `2 · Agent · Claude · ${implement}`
    ])
    openRow(1)
    fireEvent.click(screen.getByText('preset:implement:codex'))
    expect(outcome().steps[0]).toMatchObject({
      presetId: 'research',
      instructions: defaultNextStepInstructions('research')
    })
    openRow(2)
    fireEvent.change(screen.getByRole('textbox', { name: 'Instructions for agent 2' }), {
      target: { value: 'Then verify it.' }
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Move step down' })[0]!)
    expect(
      outcome().steps.map((step) => (step.kind === 'handoff' ? step.actor?.agent : ''))
    ).toEqual(['claude', 'codex'])
    expect((outcome().steps[0] as { instructions: string }).instructions).toBe('Then verify it.')
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove step' })[1]!)
    expect(outcome().steps).toHaveLength(1)
  })

  it('caps sequential agents at six and greys the templates that would pass it', async () => {
    render(
      <Harness
        initial={draftWith([
          {
            ...defaultNextStepOutcomeDraft(),
            steps: Array.from({ length: 6 }, (_, index) => handoff(String(index)))
          }
        ])}
      />
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add agent' }))
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /^Agent/ }).getAttribute('aria-disabled')).toBe(
      'true'
    )
    expect(
      screen.getByRole('menuitem', { name: /The Council/ }).getAttribute('aria-disabled')
    ).toBe('true')
    expect(screen.getByRole('menuitem', { name: /^Review/ }).getAttribute('aria-disabled')).toBe(
      null
    )
  })

  it('opens the menu on hover like ＋ and walks it with the arrow keys', () => {
    vi.useFakeTimers()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true })
    })
    try {
      render(<Harness initial={draftWith([defaultNextStepOutcomeDraft()])} />)
      fireEvent.pointerEnter(screen.getByRole('button', { name: 'Add agent' }))
      act(() => vi.advanceTimersByTime(120))
      const menu = screen.getByRole('menu')
      const items = screen.getAllByRole('menuitem')
      items[0]!.focus()
      fireEvent.keyDown(menu, { key: 'ArrowDown' })
      expect(document.activeElement).toBe(items[1])
      fireEvent.keyDown(menu, { key: 'ArrowUp' })
      expect(document.activeElement).toBe(items[0])
      fireEvent.keyDown(menu, { key: 'End' })
      expect(document.activeElement).toBe(items.at(-1))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Add agent ▾ Template', () => {
  it('unfolds Research → Plan into two agents and the Council into a review plus a synthesis', async () => {
    render(<Harness initial={draftWith([defaultNextStepOutcomeDraft()])} />)
    await addAgent(/^🔬 Research → 📝 Plan$/)
    expect(
      outcome().steps.map((step) => (step.kind === 'handoff' ? step.presetId : step.kind))
    ).toEqual(['research', 'plan'])
    await addAgent(/The Council/)
    expect(
      outcome().steps.map((step) => (step.kind === 'handoff' ? step.presetId : step.kind))
    ).toEqual(['research', 'plan', 'review', 'synthesize'])
    // The plan step already holds Codex's default, so Codex returns on another exact model.
    expect((outcome().steps[2] as { reviewers: unknown[] }).reviewers).toEqual([
      { agent: 'claude', model: 'opus' },
      { agent: 'codex', model: 'gpt-6.1-sol' }
    ])
    expect(document.querySelectorAll('[data-next-step-outcome-step]')).toHaveLength(4)
  })
})

describe('Next Person', () => {
  it('fills the package with the files the workspace changed once a person is chosen', () => {
    changed.detected = { paths: ['/work/report.md', '/work/data.csv'], truncated: false }
    render(<Harness initial={draftWith([defaultNextStepOutcomeDraft()])} />)
    expect(changed.enabled.at(-1)).toBe(false)
    expect(read().handoff.deliverables).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Team' }))
    fireEvent.click(screen.getByRole('button', { name: 'Josh' }))
    expect(changed.enabled.at(-1)).toBe(true)
    expect(read().handoff.deliverables).toEqual({
      kind: 'files',
      paths: ['/work/report.md', '/work/data.csv']
    })
    changed.detected = null
  })

  it('Team opens the people chips; one click on a person chooses them and reveals the Package', () => {
    render(<Harness initial={draftWith([defaultNextStepOutcomeDraft()])} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Team' }))
    expect(outcome().finish).toEqual({
      kind: 'person',
      personId: '',
      personName: '',
      disposition: 'ownership',
      action: 'review'
    })
    expect(teamPicker()).toBeTruthy()
    expect(document.querySelector('[data-next-step-summary="finish"]')!.textContent).toBe(
      'Choose a teammate'
    )
    expect(screen.queryByTestId('package')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Josh' }))
    expect(outcome().finish).toMatchObject({ kind: 'person', personId: 'josh', personName: 'Josh' })
    expect(teamPicker()).toBeNull()
    expect(document.querySelector('[data-next-step-summary="finish"]')!.textContent).toBe('Josh')
    expect(document.querySelector('[data-next-step-hint="finish"]')!.textContent).toBe(
      'Hand off to Josh · Hand off — they own it from here.'
    )
    expect(document.querySelector('[data-selected-recipient="josh"]')!.textContent).toContain(
      'Josh'
    )
    expect(screen.getByTestId('package').getAttribute('data-team')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: 'Me' }))
    expect(outcome().finish).toEqual({ kind: 'complete' })
    expect(screen.queryByTestId('package')).toBeNull()
    expect(document.querySelector('[data-selected-recipient]')).toBeNull()
  })

  it('Review sends for feedback that comes back; Hand off moves ownership', () => {
    render(<Harness initial={draftWith([defaultNextStepOutcomeDraft()])} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Team' }))
    fireEvent.click(screen.getByRole('button', { name: 'Josh' }))
    expect(screen.getByRole('radio', { name: 'Hand off' }).getAttribute('aria-checked')).toBe(
      'true'
    )
    expect(document.querySelector('[data-next-step-hint="finish"]')!.textContent).toContain(
      'Hand off — they own it from here.'
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Review' }))
    expect(outcome().finish).toMatchObject({
      kind: 'person',
      personId: 'josh',
      disposition: 'feedback',
      action: 'review'
    })
    expect(document.querySelector('[data-next-step-hint="finish"]')!.textContent).toBe(
      'Send to Josh for review · Review — it comes back to you with their feedback.'
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Hand off' }))
    expect(outcome().finish).toMatchObject({ disposition: 'ownership', action: 'review' })
  })

  it('chooses an existing employee agent by session ID without replacing it with the owner', async () => {
    directory.mockResolvedValue({
      ok: true,
      data: {
        agents: [
          {
            id: 'session_uma',
            employeeId: 'emp_uma',
            projectId: 'project',
            name: 'Uma existing agent'
          }
        ]
      }
    })
    const onTimingChange = vi.fn()
    render(
      <Harness
        initial={draftWith([defaultNextStepOutcomeDraft()])}
        timing="done"
        onTimingChange={onTimingChange}
      />
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Team' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose an existing employee agent' }))
    // Why: the session row carries its owner's avatar, which names it as AI for readers.
    fireEvent.click(await screen.findByRole('button', { name: /Uma existing agent/ }))
    expect(outcome().finish).toEqual({
      kind: 'person',
      personId: 'emp_uma',
      personName: 'Uma existing agent',
      action: 'fyi',
      disposition: 'ownership',
      agentRecipient: {
        kind: 'agent',
        id: 'session_uma',
        employeeId: 'emp_uma',
        projectId: 'project',
        name: 'Uma existing agent'
      }
    })
    expect(document.querySelector('[data-next-step-summary="finish"]')!.textContent).toBe(
      'Uma existing agent'
    )
    expect(document.querySelector('[data-next-step-hint="finish"]')!.textContent).toBe(
      'Hand off to Uma existing agent'
    )
    // Why: the agent session owns it as an FYI; neither a review round-trip nor Send now applies.
    expect(screen.queryByRole('radio', { name: 'Review' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send now' })).toBeNull()
    expect(teamPicker()).toBeNull()
    // Why: the chosen agent's chip reopens the picker; its avatar names it as AI for readers.
    fireEvent.click(screen.getByRole('button', { name: /Uma existing agent/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Josh' }))
    expect(outcome().finish).toMatchObject({ kind: 'person', personId: 'josh', personName: 'Josh' })
    expect((outcome().finish as { agentRecipient?: unknown }).agentRecipient).toBeUndefined()
    expect(screen.getByRole('radio', { name: 'Hand off' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send now' })).toBeTruthy()
  })

  it('hydrates a legacy my-review as Me without rewriting it', () => {
    render(
      <Harness
        initial={draftWith([{ ...emptyNextStepOutcomeDraft(), finish: { kind: 'my-review' } }])}
      />
    )
    expect(screen.getByRole('radio', { name: 'Me' }).getAttribute('aria-checked')).toBe('true')
    expect(outcome().finish).toEqual({ kind: 'my-review' })
  })

  it('shows a legacy GitHub finish read-only with a way back to Me', () => {
    render(
      <Harness
        initial={draftWith([
          {
            ...emptyNextStepOutcomeDraft(),
            finish: { kind: 'github', action: 'merge', repository: 'owner/repo' }
          }
        ])}
      />
    )
    expect(
      screen.getByText('GitHub finish: Merge · owner/repo (set in an earlier version)')
    ).toBeTruthy()
    expect(screen.queryByRole('radio', { name: 'Team' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Me' }))
    expect(outcome().finish).toEqual({ kind: 'complete' })
    expect(screen.getByRole('radio', { name: 'Me' })).toBeTruthy()
  })

  it('offers Send now only for a Team handoff with no agent work, and hides When done while sending now', () => {
    const onTimingChange = vi.fn()
    const person = {
      ...emptyNextStepOutcomeDraft(),
      finish: {
        kind: 'person' as const,
        personId: 'josh',
        personName: 'Josh',
        disposition: 'ownership' as const,
        action: 'review' as const
      }
    }
    render(<Harness initial={draftWith([person])} timing="done" onTimingChange={onTimingChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }))
    expect(onTimingChange).toHaveBeenCalledWith('now')
    expect(screen.getByRole('button', { name: 'After the work above' })).toBeTruthy()
    expect(screen.getByTestId('once-done')).toBeTruthy()
    cleanup()
    render(<Harness initial={draftWith([person])} timing="now" onTimingChange={onTimingChange} />)
    expect(screen.queryByTestId('once-done')).toBeNull()
    cleanup()
    render(
      <Harness
        initial={draftWith([{ ...person, steps: [handoff('a')] }])}
        timing="done"
        onTimingChange={onTimingChange}
      />
    )
    expect(screen.queryByRole('button', { name: 'Send now' })).toBeNull()
  })
})

describe('several saved outcomes', () => {
  const two = (saved: boolean): NextStepDraft =>
    draftWith([
      { ...emptyNextStepOutcomeDraft(), id: 'first', finish: { kind: 'complete' } },
      {
        ...emptyNextStepOutcomeDraft(),
        id: 'second',
        ...(saved ? { revision: 1 } : {}),
        finish: {
          kind: 'person',
          personId: 'josh',
          personName: 'Josh',
          action: 'review',
          disposition: 'ownership'
        }
      }
    ])

  it('switches between outcomes and removes a never-saved one without recording a scope change', () => {
    render(<Harness initial={two(false)} />)
    expect(screen.getByText('Outcome 1 of 2 → Back to me')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next outcome' }))
    expect(screen.getByText('Outcome 2 of 2 → Hand off to Josh')).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Team' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Remove outcome 2' }))
    expect(screen.queryByText('Why is this outcome leaving scope?')).toBeNull()
    expect(screen.queryByText(/Outcome 1 of/)).toBeNull()
    expect(read().outcomeRemovals).toEqual([])
    expect(read().outcomes).toHaveLength(1)
  })

  it('requires and records a reason when removing a committed outcome', () => {
    render(<Harness initial={two(true)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Next outcome' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove outcome 2' }))
    expect(screen.getByText('Why is this outcome leaving scope?')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Confirm scope change' }).hasAttribute('disabled')
    ).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Removal reason for outcome 2' }), {
      target: { value: 'No longer needed' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm scope change' }))
    expect(read().outcomeRemovals).toEqual([{ outcomeId: 'second', reason: 'No longer needed' }])
    expect(read().outcomes!.map((entry) => entry.id)).toEqual(['first'])
  })
})
