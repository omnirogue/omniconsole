import { describe, expect, it } from 'vitest'
import { projectSessionState, type SessionStateFacts } from './session-manage-state'

function facts(overrides: Partial<SessionStateFacts> = {}): SessionStateFacts {
  return {
    verdict: 'live',
    activity: { kind: 'idle' },
    queueLength: 0,
    pendingSteps: [],
    ...overrides
  }
}

describe('projectSessionState', () => {
  it.each([
    ['working', facts({ activity: { kind: 'working', activity: 'Fix the parser' } })],
    ['queued', facts({ queueLength: 2 })],
    ['provider-limited', facts({ providerLimit: { resetAt: Date.UTC(2026, 8, 24, 12) } })],
    [
      'provider-limited',
      facts({ activity: { kind: 'idle', failure: 'You hit your limit', usageLimited: true } })
    ],
    ['awaiting-user', facts({ activity: { kind: 'permission', prompt: 'Allow rm?' } })],
    ['awaiting-user', facts({ activity: { kind: 'question', prompt: 'Which branch?' } })],
    ['waiting-for-yes', facts({ pendingSteps: ['Add the migration'] })],
    ['idle', facts()],
    ['exited', facts({ verdict: 'exited', verdictReason: 'Its tab is closed.' })]
  ] as const)('reads %s', (state, input) => {
    expect(projectSessionState(input).state).toBe(state)
  })

  it('says what it waits on in plain words', () => {
    expect(projectSessionState(facts({ pendingSteps: ['Add the migration'] })).waitingOn).toBe(
      'A yes to its own proposal: Add the migration'
    )
    expect(projectSessionState(facts({ pendingSteps: ['a', 'b', 'c'] })).waitingOn).toBe(
      'A choice among its 3 proposed next steps.'
    )
    expect(projectSessionState(facts({ queueLength: 1 })).waitingOn).toBe(
      '1 queued prompt, sent as soon as it is free.'
    )
    expect(
      projectSessionState(facts({ activity: { kind: 'permission', prompt: 'Allow  rm\n -rf?' } }))
        .waitingOn
    ).toBe('Your answer to a permission prompt: Allow rm -rf?')
    expect(projectSessionState(facts({ activity: { kind: 'working' } })).waitingOn).toBeNull()
  })

  it('is conservative: an unreadable agent is unknown, never idle', () => {
    expect(
      projectSessionState(facts({ activity: { kind: 'unknown', reason: 'No hook row.' } }))
    ).toEqual({ state: 'unknown', waitingOn: 'No hook row.' })
    // Steps and queue do not promote an unknown agent to waiting-for-yes or queued.
    expect(
      projectSessionState(
        facts({ activity: { kind: 'unknown' }, pendingSteps: ['x'], queueLength: 3 })
      ).state
    ).toBe('unknown')
  })

  it('reads an unverifiable host as unknown, never exited', () => {
    const projected = projectSessionState(
      facts({
        verdict: 'unverifiable',
        verdictReason: 'Its host is not connected, so its state cannot be verified.',
        activity: { kind: 'working' }
      })
    )
    expect(projected).toEqual({
      state: 'unknown',
      waitingOn: 'Its host is not connected, so its state cannot be verified.'
    })
  })

  it('reads a launching agent as unknown', () => {
    expect(projectSessionState(facts({ launchPending: true })).state).toBe('unknown')
  })

  it('lets a person-facing prompt outrank queued prompts and steps', () => {
    expect(
      projectSessionState(
        facts({ activity: { kind: 'question' }, queueLength: 1, pendingSteps: ['x'] })
      ).state
    ).toBe('awaiting-user')
    expect(
      projectSessionState(facts({ activity: { kind: 'working' }, queueLength: 4 })).state
    ).toBe('working')
  })

  it('names a failed last turn without calling the session dead', () => {
    expect(
      projectSessionState(facts({ activity: { kind: 'idle', failure: 'Auth expired' } }))
    ).toEqual({ state: 'idle', waitingOn: 'Its last turn failed: Auth expired' })
  })

  it('says what its outcome plan waits on, after its queue and its own proposals', () => {
    const planWaits = ['Uma approves on Slack (not yet, checked 2026-09-24T21:00:00.000Z)']
    expect(projectSessionState(facts({ planWaits }))).toEqual({
      state: 'idle',
      waitingOn:
        'Its plan is waiting for Uma approves on Slack (not yet, checked 2026-09-24T21:00:00.000Z)'
    })
    expect(projectSessionState(facts({ planWaits, queueLength: 1 })).state).toBe('queued')
    expect(projectSessionState(facts({ planWaits, activity: { kind: 'working' } })).waitingOn).toBe(
      null
    )
  })
})
