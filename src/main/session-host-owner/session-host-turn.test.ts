import { describe, expect, it } from 'vitest'
import type { ConversationSource } from '../../shared/conversation-source'
import { classifyHookTurnSignal, type HookTurnEvidence } from '../next-steps/next-step-turn-signal'
import { UNREAD_TURN } from '../session-manage/session-manage-freeform'
import { sessionHostTurnRevision, withEndedLeadTurn } from './session-host-turn'

const SOURCE: ConversationSource = { kind: 'pty', worktreeId: 'wt', paneKey: 'tab:1' }
const STAMP = 1_760_303_497_000
const LATER = STAMP + 60_000
// What next steps hold after a restart when the lead's turn never read as finished.
const NO_TURN_HELD = { ...UNREAD_TURN, known: true }
const MONITORING = {
  state: 'working',
  workingMode: 'monitoring',
  turnCompletedAt: STAMP,
  stateStartedAt: STAMP - 600_000
} as const

function revision(row: Parameters<typeof withEndedLeadTurn>[2], turn = NO_TURN_HELD) {
  return sessionHostTurnRevision(withEndedLeadTurn(turn, SOURCE, row))
}

// The key next steps give a done row when they do read it (finished or skipped alike).
function nextStepsRevision(payload: HookTurnEvidence['payload'], stateStartedAt: number) {
  const signal = classifyHookTurnSignal({ ...SOURCE, stateStartedAt, payload })
  return revision(null, { ...NO_TURN_HELD, turnKey: 'turnKey' in signal ? signal.turnKey : null })
}

describe('withEndedLeadTurn', () => {
  it('names the turn Claude finished while its background work still runs', () => {
    const named = revision(MONITORING)
    expect(named).toMatch(/^turn:/)
    expect(named).not.toBe('turn:none')
    expect(named).toBe(nextStepsRevision({ state: 'done', turnCompletedAt: STAMP }, LATER))
  })

  it('keeps that name when the background work ends with the child’s all-clear', () => {
    expect(revision({ state: 'done', turnCompletedAt: STAMP, stateStartedAt: LATER })).toBe(
      revision(MONITORING)
    )
  })

  it('names a turn next steps skipped, by the key they give it', () => {
    for (const ended of [{}, { interrupted: true }, { failed: true }] as const) {
      const row = { state: 'done', stateStartedAt: LATER, ...ended } as const
      const named = revision(row)
      expect(named).toMatch(/^turn:/)
      expect(named).toBe(nextStepsRevision(row, LATER))
    }
  })

  it('keeps the turn next steps hold', () => {
    const held = { ...NO_TURN_HELD, turnKey: 'tab:1@5' }
    expect(withEndedLeadTurn(held, SOURCE, MONITORING)).toBe(held)
  })

  it('stays unknown while the lead itself is working, or without a mark', () => {
    for (const row of [
      { state: 'working', turnCompletedAt: STAMP, stateStartedAt: LATER },
      { state: 'waiting', stateStartedAt: LATER },
      { state: 'working', workingMode: 'monitoring', stateStartedAt: LATER },
      { state: 'done', turnCompletedAt: STAMP, stateStartedAt: LATER, sessionBoundary: true },
      null
    ] as const) {
      expect(revision(row)).toBeNull()
    }
  })

  it('does not name a turn the host could not read', () => {
    expect(revision(MONITORING, UNREAD_TURN)).toBeNull()
  })
})
