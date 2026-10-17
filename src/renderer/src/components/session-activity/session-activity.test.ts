import { describe, expect, it } from 'vitest'
import type { SessionChain } from '../../../../shared/session-chain-types'
import {
  describeSessionActivity,
  SESSION_ACTIVITY_LINE_MAX,
  showsSessionActivityOnRow,
  type SessionActivityStatus
} from './session-activity'

const NOW = 1_800_000_000_000
const PANE = 'term:tab-1:pane-1'

function chain(overrides: Partial<SessionChain> = {}): SessionChain {
  return {
    id: 'chn_1',
    workspacePath: '/workspace',
    worktreeId: 'repo:/workspace',
    hostId: 'local',
    sourcePaneKey: 'term:tab-0:pane-0',
    sourceRowKey: 'row-0',
    auto: true,
    currentIndex: 2,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    steps: [
      { id: 's1', agent: 'claude', prompt: 'Build it', status: 'launched' },
      {
        id: 's2',
        agent: 'codex',
        prompt: 'Review it',
        presetId: 'review',
        status: 'launched',
        launchedPaneKey: PANE
      },
      { id: 's3', agent: 'claude', prompt: 'Repair it', status: 'queued' },
      { id: 's4', agent: 'claude', prompt: 'Ship it', status: 'queued' }
    ],
    ...overrides
  } as SessionChain
}

function status(overrides: Partial<SessionActivityStatus> = {}): SessionActivityStatus {
  return { state: 'working', stateStartedAt: NOW - 180_000, ...overrides }
}

describe('describeSessionActivity — a pane a plan launched', () => {
  it('says which step of the plan the pane is, and what that step is', () => {
    const summary = describeSessionActivity({ chain: chain(), paneKey: PANE, now: NOW })
    expect(summary.signal).toBe('chain')
    expect(summary.step).toEqual({ index: 2, total: 4, what: '👀 Review · Codex', round: null })
    expect(summary.line).toBe('Step 2 of 4 · 👀 Review · Codex')
  })

  it('appends the round when the step is one of several rounds of the same action', () => {
    const base = chain()
    const rounds = chain({
      steps: base.steps.map((step, index) =>
        index === 1 ? ({ ...step, round: { key: 'r1', index: 2, total: 3 } } as never) : step
      )
    })
    expect(describeSessionActivity({ chain: rounds, paneKey: PANE, now: NOW }).line).toBe(
      'Step 2 of 4 · 👀 Review · Codex · ↻ 2/3'
    )
  })

  it('claims no step for the session the plan is queued AFTER — that is not a step', () => {
    const summary = describeSessionActivity({
      chain: chain(),
      paneKey: 'term:tab-0:pane-0',
      status: status(),
      now: NOW
    })
    expect(summary.signal).not.toBe('chain')
    expect(summary.step).toBeNull()
  })
})

describe('describeSessionActivity — a published task list', () => {
  const todos = [
    { text: 'Read the brief', status: 'completed' as const },
    { text: 'Write the tests', status: 'current' as const },
    { text: 'Open the PR', status: 'pending' as const }
  ]

  it('leads with progress and the current task when no plan step applies', () => {
    const summary = describeSessionActivity({ status: status(), todos, now: NOW })
    expect(summary.signal).toBe('todos')
    expect(summary.line).toBe('1/3 · Write the tests')
    expect(summary.todos).toEqual(todos)
  })

  it('keeps the list on a plan step too, with the step as the headline', () => {
    const summary = describeSessionActivity({ chain: chain(), paneKey: PANE, todos, now: NOW })
    expect(summary.signal).toBe('chain')
    expect(summary.line).toBe('Step 2 of 4 · 👀 Review · Codex')
    expect(summary.detail).toBe('1/3 · Write the tests')
    expect(summary.todos).toEqual(todos)
  })

  it('says so when every task is ticked', () => {
    expect(
      describeSessionActivity({
        status: status(),
        todos: [{ text: 'Done', status: 'completed' }],
        now: NOW
      }).line
    ).toBe('All 1 tasks done')
  })
})

describe('describeSessionActivity — the activity fallback', () => {
  it('uses the running tool and its input', () => {
    const summary = describeSessionActivity({
      status: status({ toolName: 'Edit', toolInput: 'src/renderer/src/App.tsx' }),
      now: NOW
    })
    expect(summary.signal).toBe('activity')
    expect(summary.line).toBe('Editing App.tsx')
    // The literal call stays reachable for a hover.
    expect(summary.full).toBe('Edit · src/renderer/src/App.tsx')
    expect(summary.state?.state).toBe('working')
    // Copy changed 2026-09-18 (brief 78, rec. 5): a relative age, not "since this minute".
    expect(summary.state?.line).toBe('Working · 3 min ago')
    expect(summary.state?.at).toBe(NOW - 180_000)
    expect(summary.quotesAgent).toBe(false)
  })

  it('uses the latest assistant turn when no tool is running', () => {
    const summary = describeSessionActivity({
      status: status({
        state: 'done',
        lastAssistantMessage: '  I fixed the failing test\n and pushed the branch  '
      }),
      now: NOW
    })
    expect(summary.signal).toBe('activity')
    expect(summary.line).toBe('I fixed the failing test and pushed the branch')
    expect(summary.state?.label).toBe('Finished its turn')
  })

  it('never shows a tool result as something the agent said', () => {
    const summary = describeSessionActivity({
      status: status({
        state: 'done',
        lastAssistantMessage: 'exit code 1',
        lastAssistantMessageIsToolOutput: true,
        lastCompletedAssistantMessage: 'The suite is green'
      }),
      now: NOW
    })
    expect(summary.line).toBe('The suite is green')
  })

  it('trims a long line so a row can never be pushed around', () => {
    const summary = describeSessionActivity({
      status: status({ toolName: 'Bash', toolInput: 'x'.repeat(400) }),
      now: NOW
    })
    expect(summary.line.length).toBeLessThanOrEqual(SESSION_ACTIVITY_LINE_MAX)
    expect(summary.line.endsWith('…')).toBe(true)
  })

  it('falls back to the hook state alone when the pane said nothing yet', () => {
    const summary = describeSessionActivity({ status: status({ state: 'blocked' }), now: NOW })
    expect(summary.signal).toBe('activity')
    expect(summary.line).toBe('Blocked on a decision')
  })
})

describe('describeSessionActivity — nothing known', () => {
  it('says status unknown rather than returning a blank line', () => {
    const summary = describeSessionActivity({ now: NOW })
    expect(summary.signal).toBe('unknown')
    expect(summary.line).toBe('Status unknown')
    expect(summary.detail).toBeNull()
    expect(summary.state).toBeNull()
    expect(summary.todos).toEqual([])
  })

  it('does not invent a start time from an impossible one', () => {
    expect(
      describeSessionActivity({ status: status({ stateStartedAt: 0 }), now: NOW }).state?.line
    ).toBe('Working')
  })
})

describe('showsSessionActivityOnRow', () => {
  it('shows a plan step and a task list, and live activity', () => {
    expect(
      showsSessionActivityOnRow(
        describeSessionActivity({ chain: chain(), paneKey: PANE, now: NOW })
      )
    ).toBe(true)
    expect(
      showsSessionActivityOnRow(
        describeSessionActivity({ todos: [{ text: 'A', status: 'pending' }], now: NOW })
      )
    ).toBe(true)
    expect(
      showsSessionActivityOnRow(
        describeSessionActivity({ status: status({ toolName: 'Bash' }), now: NOW })
      )
    ).toBe(true)
  })

  it('stays off a row with nothing known, and off a finished row that has no plan step', () => {
    expect(showsSessionActivityOnRow(describeSessionActivity({ now: NOW }))).toBe(false)
    expect(
      showsSessionActivityOnRow(
        describeSessionActivity({
          status: status({ state: 'done', lastAssistantMessage: 'All done' }),
          now: NOW
        })
      )
    ).toBe(false)
  })
})

describe('describeSessionActivity — the preview as a person reads it', () => {
  it('prints the last words without their markdown markers, and says so', () => {
    const summary = describeSessionActivity({
      status: status({
        state: 'done',
        lastAssistantMessage:
          '**Since 13:01:** Cash is `unchanged`. Clerk +**2** for [OmniRogue](https://x), ~~1~~ 0 for *BetaCorp*.'
      }),
      now: NOW
    })
    expect(summary.line).toBe(
      'Since 13:01: Cash is unchanged. Clerk +2 for OmniRogue, 1 0 for BetaCorp.'
    )
    expect(summary.quotesAgent).toBe(true)
  })

  it('keeps a lone underscore: snake_case is a word, not emphasis', () => {
    const summary = describeSessionActivity({
      status: status({ state: 'done', lastAssistantMessage: 'Renamed foo_bar to __baz__' }),
      now: NOW
    })
    expect(summary.line).toBe('Renamed foo_bar to baz')
  })

  it.each([
    [NOW - 20_000, 'Finished its turn · just now'],
    [NOW - 4 * 60_000, 'Finished its turn · 4 min ago'],
    [NOW - 3 * 3_600_000, 'Finished its turn · 3 h ago'],
    [NOW - 2 * 86_400_000, 'Finished its turn · 2 d ago']
  ])('ages the state from %i as a person says it', (stateStartedAt, line) => {
    const summary = describeSessionActivity({
      status: status({ state: 'done', stateStartedAt }),
      now: NOW
    })
    expect(summary.state?.line).toBe(line)
    expect(summary.state?.at).toBe(stateStartedAt)
  })

  it('has no age when the start is unknown', () => {
    const summary = describeSessionActivity({
      status: status({ state: 'done', stateStartedAt: 0 }),
      now: NOW
    })
    expect(summary.state?.line).toBe('Finished its turn')
    expect(summary.state?.at).toBeNull()
  })
})
