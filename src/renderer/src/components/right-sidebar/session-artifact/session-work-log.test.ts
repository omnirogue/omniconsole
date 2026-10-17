import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../shared/native-chat-types'
import { sessionWorkLogTurns, statusWorkLogTurns } from './session-work-log'

let counter = 0
function message(
  role: NativeChatMessage['role'],
  blocks: NativeChatMessage['blocks'],
  timestamp: number
): NativeChatMessage {
  counter += 1
  return { id: `m${counter}`, role, blocks, timestamp, source: 'transcript' }
}
const text = (value: string) => ({ type: 'text' as const, text: value })
const tool = { type: 'tool-call' as const, name: 'Bash', input: {} }

describe('sessionWorkLogTurns', () => {
  it('lists each turn newest first with its steps and last line', () => {
    const turns = sessionWorkLogTurns([
      message('user', [text('Build the side panel')], 1_000),
      message('assistant', [text('Reading the code'), tool, tool], 2_000),
      message('assistant', [text('**Done.** PR #700 is open\nMore detail')], 3_000),
      message('user', [text('Now add tests')], 4_000),
      message('assistant', [tool], 5_000)
    ])
    expect(turns).toEqual([
      expect.objectContaining({ prompt: 'Now add tests', steps: 1, result: null, endedAt: 5_000 }),
      expect.objectContaining({
        prompt: 'Build the side panel',
        steps: 2,
        result: 'Done. PR #700 is open',
        startedAt: 1_000,
        endedAt: 3_000
      })
    ])
  })

  it('does not treat injected command output or notifications as prompts', () => {
    const turns = sessionWorkLogTurns([
      message('user', [text('Watch the build')], 1),
      message('user', [text('<task-notification>shell finished</task-notification>')], 2),
      message('assistant', [text('The build passed')], 3)
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ prompt: 'Watch the build', result: 'The build passed' })
  })

  it('shows nothing before the first prompt', () => {
    expect(sessionWorkLogTurns([message('assistant', [text('hi')], 1)])).toEqual([])
  })
})

describe('statusWorkLogTurns', () => {
  const history = [
    { state: 'working' as const, prompt: 'Draft the plan', startedAt: 1_000 },
    { state: 'done' as const, prompt: 'Draft the plan', startedAt: 2_000 },
    { state: 'working' as const, prompt: 'Try the risky step', startedAt: 3_000 },
    { state: 'done' as const, prompt: 'Try the risky step', startedAt: 4_000, interrupted: true }
  ]

  it('reads each turn from hook history with how it ended, and the reply on the newest', () => {
    const turns = statusWorkLogTurns({
      state: 'done',
      prompt: 'Write the tests',
      stateStartedAt: 6_000,
      stateHistory: [...history, { state: 'working', prompt: 'Write the tests', startedAt: 5_000 }],
      lastAssistantMessage: '**Done.** 12 tests added'
    })
    expect(turns).toEqual([
      expect.objectContaining({
        prompt: 'Write the tests',
        startedAt: 5_000,
        result: 'Done. 12 tests added'
      }),
      expect.objectContaining({ prompt: 'Try the risky step', result: null, ended: 'interrupted' }),
      expect.objectContaining({ prompt: 'Draft the plan', result: null, ended: 'finished' })
    ])
  })

  it('leaves a running turn without a reply and gives the last finished one its reply', () => {
    const turns = statusWorkLogTurns({
      state: 'working',
      prompt: 'Next step',
      stateStartedAt: 5_000,
      stateHistory: history.slice(0, 2),
      lastCompletedAssistantMessage: 'Plan is ready'
    })
    expect(turns.map((turn) => [turn.prompt, turn.result, turn.ended])).toEqual([
      ['Next step', null, undefined],
      ['Draft the plan', 'Plan is ready', 'finished']
    ])
  })

  it('keeps two turns that asked the same thing apart, each with its own outcome', () => {
    const turns = statusWorkLogTurns({
      state: 'done',
      prompt: 'continue',
      stateStartedAt: 4_000,
      stateHistory: [
        { state: 'working', prompt: 'continue', startedAt: 1_000 },
        { state: 'done', prompt: 'continue', startedAt: 2_000, interrupted: true },
        { state: 'working', prompt: 'continue', startedAt: 3_000 }
      ],
      lastAssistantMessage: 'All set'
    })
    expect(turns.map((turn) => [turn.startedAt, turn.ended, turn.result])).toEqual([
      [3_000, 'finished', 'All set'],
      [1_000, 'interrupted', null]
    ])
  })

  it('makes nothing of a session start or resume, and ends a turn at one', () => {
    expect(
      statusWorkLogTurns({
        state: 'done',
        prompt: '',
        stateStartedAt: 1,
        stateHistory: [],
        sessionBoundary: true
      })
    ).toEqual([])
    const turns = statusWorkLogTurns({
      state: 'done',
      prompt: '',
      stateStartedAt: 3_000,
      sessionBoundary: true,
      stateHistory: [
        { state: 'working', prompt: 'Draft', startedAt: 1_000 },
        { state: 'done', prompt: 'Draft', startedAt: 2_000 }
      ],
      lastCompletedAssistantMessage: 'Drafted'
    })
    expect(turns.map((turn) => [turn.prompt, turn.ended, turn.result])).toEqual([
      ['Draft', 'finished', 'Drafted']
    ])
  })

  it('is empty without a hook row', () => {
    expect(statusWorkLogTurns(undefined)).toEqual([])
  })
})
