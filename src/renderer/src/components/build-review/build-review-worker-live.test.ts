import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { BuildReviewWorkerSnapshot } from '../../../../shared/build-review-pipeline'
import {
  findWorkerStatusRow,
  formatWorkerElapsed,
  workerActivity,
  workerDisplayStatus,
  workerDotState,
  workerMessagePreview
} from './build-review-worker-live'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, args?: Record<string, unknown>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(args?.[key] ?? ''))
}))

function worker(status: BuildReviewWorkerSnapshot['status']): BuildReviewWorkerSnapshot {
  return {
    role: 'builder',
    choice: { agent: 'codex' },
    status,
    taskId: null,
    dispatchId: null,
    terminalHandle: 'term_1',
    report: null,
    error: null
  }
}

function row(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 10,
    stateStartedAt: 5,
    paneKey: 'tab:leaf',
    terminalHandle: 'term_1',
    stateHistory: [],
    ...overrides
  }
}

describe('findWorkerStatusRow', () => {
  it('finds the newest hook row carrying the worker terminal handle', () => {
    const stale = row({ paneKey: 'a', updatedAt: 1 })
    const fresh = row({ paneKey: 'b', updatedAt: 9 })
    const other = row({ paneKey: 'c', terminalHandle: 'term_2', updatedAt: 20 })
    expect(findWorkerStatusRow({ a: stale, b: fresh, c: other }, 'term_1')).toBe(fresh)
    expect(findWorkerStatusRow({ a: stale }, null)).toBeNull()
    expect(findWorkerStatusRow(undefined, 'term_1')).toBeNull()
    expect(findWorkerStatusRow({ c: other }, 'term_1')).toBeNull()
  })
})

describe('workerDisplayStatus', () => {
  it('names a start Running once its hooks say the agent is working', () => {
    expect(workerDisplayStatus(worker('starting'), row({ state: 'working' }))).toBe('running')
    // No hook row yet, or the agent between turns: still starting.
    expect(workerDisplayStatus(worker('starting'), null)).toBe('starting')
    expect(workerDisplayStatus(worker('starting'), row({ state: 'done' }))).toBe('starting')
    // A startup question the person has to answer keeps it starting, whatever its hooks say.
    const asking = { ...worker('starting'), startupBlocker: 'codex-hooks-review-prompt' }
    expect(workerDisplayStatus(asking, row({ state: 'working' }))).toBe('starting')
    // Every other status is the worker's own.
    expect(workerDisplayStatus(worker('failed'), row({ state: 'working' }))).toBe('failed')
    expect(workerDisplayStatus(worker('succeeded'), row({ state: 'working' }))).toBe('succeeded')
  })
})

describe('workerDotState', () => {
  it('uses the hook state while the worker runs and the worker status otherwise', () => {
    expect(workerDotState(worker('pending'), row())).toBe('idle')
    expect(workerDotState(worker('succeeded'), row({ state: 'working' }))).toBe('done')
    expect(workerDotState(worker('failed'), null)).toBe('failed')
    expect(workerDotState(worker('starting'), null)).toBe('working')
    expect(workerDotState(worker('running'), row({ state: 'waiting' }))).toBe('waiting')
    expect(workerDotState(worker('running'), row({ state: 'blocked' }))).toBe('blocked')
    expect(workerDotState(worker('running'), row({ workingMode: 'monitoring' }))).toBe('monitoring')
    expect(workerDotState(worker('running'), row({ state: 'done', interrupted: true }))).toBe(
      'interrupted'
    )
  })

  it('never shows a finished check for a worker that is still running', () => {
    // A failed turn (provider error, rate limit) leaves the worker stuck, not done.
    expect(workerDotState(worker('running'), row({ state: 'done', failed: true }))).toBe('failed')
    // An ordinary turn end while the run still waits for the report is idle.
    expect(workerDotState(worker('running'), row({ state: 'done' }))).toBe('idle')
  })
})

describe('workerActivity', () => {
  it.each([
    ['Edit', 'src/x.ts', 'Editing src/x.ts'],
    ['apply_patch', '', 'Editing files'],
    ['Read', 'src/y.ts', 'Reading src/y.ts'],
    ['Grep', 'handleKey', 'Searching handleKey'],
    ['Bash', 'pnpm tc:web\nsecond line', 'Running pnpm tc:web'],
    ['exec_command', '', 'Running a command'],
    ['WebFetch', 'https://example.com', 'Fetching https://example.com'],
    ['TodoWrite', '', 'Running TodoWrite'],
    ['mcp__docs__search', 'hooks', 'Running mcp__docs__search hooks']
  ])('describes %s %j as %j', (toolName, toolInput, expected) => {
    expect(workerActivity(worker('running'), row({ toolName, toolInput }))).toBe(expected)
  })

  it('names waits and turns without a tool', () => {
    expect(workerActivity(worker('running'), row())).toBe('Thinking')
    expect(workerActivity(worker('running'), row({ state: 'waiting', toolName: 'Bash' }))).toBe(
      'Waiting for permission: Bash'
    )
    expect(workerActivity(worker('running'), row({ state: 'blocked' }))).toBe(
      'Needs your input in its terminal'
    )
    expect(workerActivity(worker('running'), row({ state: 'done' }))).toBe(
      'Finished a turn; waiting for its report'
    )
    expect(
      workerActivity(
        worker('running'),
        row({ state: 'done', failed: true, failureReason: ' Rate limit reached ' })
      )
    ).toBe('Its last turn failed: Rate limit reached')
    expect(workerActivity(worker('running'), row({ state: 'done', failed: true }))).toBe(
      'Its last turn failed; check its terminal'
    )
    expect(workerActivity(worker('running'), row({ state: 'done', interrupted: true }))).toBe(
      'Its last turn was interrupted; check its terminal'
    )
    expect(workerActivity(worker('starting'), null)).toBe('Starting the agent…')
    expect(workerActivity(worker('running'), null)).toBe('Working')
  })

  it("sums up the worker's own orchestration calls instead of showing the raw command", () => {
    const send =
      '"/Users/maintainer/Library/Application Support/omni-dev/cli/bin/omni-dev" orchestration send --from term_add86665-4c83-496e --to term_coord'
    const reviewer = { ...worker('running'), role: 'reviewer' as const }
    expect(workerActivity(reviewer, row({ toolName: 'Bash', toolInput: send }))).toBe(
      'Sending the review…'
    )
    expect(workerActivity(worker('running'), row({ toolName: 'Bash', toolInput: send }))).toBe(
      'Sending its report…'
    )
    expect(
      workerActivity(
        worker('running'),
        row({ toolName: 'exec_command', toolInput: 'omni orchestration ask --question "Keep it?"' })
      )
    ).toBe('Asking you a question…')
    expect(
      workerActivity(
        worker('running'),
        row({ toolName: 'Bash', toolInput: 'orca.exe orchestration check --wait' })
      )
    ).toBe('Checking for messages…')
    // An ordinary command that only mentions the word stays as it is.
    expect(
      workerActivity(
        worker('running'),
        row({ toolName: 'Bash', toolInput: 'grep orchestration src' })
      )
    ).toBe('Running grep orchestration src')
  })

  it('shows a worker waiting on its startup question as waiting on the person', () => {
    const waiting = { ...worker('starting'), startupBlocker: 'claude-folder-trust' }
    expect(workerActivity(waiting, null)).toBe('Waiting for your answer in its terminal')
    expect(workerActivity(waiting, row({ toolName: 'Edit' }))).toBe(
      'Waiting for your answer in its terminal'
    )
    expect(workerDotState(waiting, row())).toBe('blocked')
    // Once it failed on the question, it is shown failed, as before.
    expect(workerDotState({ ...waiting, status: 'failed' }, null)).toBe('failed')
  })

  it('says nothing once the worker reported or before it started', () => {
    expect(workerActivity(worker('succeeded'), row({ toolName: 'Edit' }))).toBeNull()
    expect(workerActivity(worker('pending'), null)).toBeNull()
  })
})

describe('workerMessagePreview', () => {
  it('shows the agent prose, never a tool output', () => {
    expect(workerMessagePreview(row({ lastAssistantMessage: '  Working on it.  ' }))).toBe(
      'Working on it.'
    )
    expect(
      workerMessagePreview(
        row({ lastAssistantMessage: 'npm ERR!', lastAssistantMessageIsToolOutput: true })
      )
    ).toBeNull()
    expect(workerMessagePreview(row({ lastCompletedAssistantMessage: 'Earlier turn.' }))).toBe(
      'Earlier turn.'
    )
    expect(workerMessagePreview(null)).toBeNull()
  })
})

it('formats elapsed time compactly', () => {
  expect(formatWorkerElapsed(-5)).toBe('0s')
  expect(formatWorkerElapsed(45_900)).toBe('45s')
  expect(formatWorkerElapsed(125_000)).toBe('2m 05s')
  expect(formatWorkerElapsed(3_720_000)).toBe('1h 02m')
})
