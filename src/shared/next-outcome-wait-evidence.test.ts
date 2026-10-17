import { describe, expect, it } from 'vitest'
import { resolveNextOutcomeWaits } from './next-outcome-wait-request'
import { nextOutcomeWaitEvidenced } from './next-outcome-wait-evidence'
import { validateNextOutcomeIntentSubmission } from './next-outcome-intent-definition'
import type { SessionOutcomeCondition } from './session-outcome-types'

const NOW = Date.parse('2026-09-24T16:00:00Z')
const roster = [
  { id: 'emp_uma', name: 'Uma Demir' },
  { id: 'emp_iris', name: 'Iris Khan' }
]
const iso = (offset: number) => new Date(NOW + offset).toISOString()

function event(value: NonNullable<SessionOutcomeCondition['event']>): SessionOutcomeCondition {
  return { id: 'wait_1', kind: 'event', target: 'wait', event: value }
}

function admitted(prompt: string, condition: SessionOutcomeCondition): boolean {
  return nextOutcomeWaitEvidenced(condition, prompt, resolveNextOutcomeWaits(prompt, roster), NOW)
}

describe('nextOutcomeWaitEvidenced', () => {
  const slack = 'Wait for Uma and Iris to approve on Slack, then close this session'
  const ask = { ref: 'slack:D123:1727190000.1', since: iso(-60_000) }

  it('admits a named person on the named channel', () => {
    expect(
      admitted(slack, event({ source: 'slack', match: 'approve', personId: 'emp_iris', ...ask }))
    ).toBe(true)
  })

  it('refuses a person, channel or answer the prompt did not ask for', () => {
    expect(
      admitted(slack, event({ source: 'slack', match: 'approve', personId: 'emp_other', ...ask }))
    ).toBe(false)
    expect(
      admitted(
        slack,
        event({
          source: 'email',
          match: 'approve',
          personId: 'emp_uma',
          ref: 'email:m:t',
          since: ask.since
        })
      )
    ).toBe(false)
    expect(
      admitted(
        'Wait for Uma to reply on Slack',
        event({ source: 'slack', match: 'reply', personId: 'emp_uma', ...ask })
      )
    ).toBe(true)
    expect(
      admitted(
        'Wait for Uma to approve on Slack',
        event({ source: 'slack', match: 'reply', personId: 'emp_uma', ...ask })
      )
    ).toBe(false)
  })

  it('refuses a since that would let an old answer count', () => {
    expect(
      admitted(
        slack,
        event({
          source: 'slack',
          match: 'approve',
          personId: 'emp_uma',
          ref: ask.ref,
          since: iso(-3 * 86_400_000)
        })
      )
    ).toBe(false)
  })

  it('holds a Jira wait to the key the person typed', () => {
    const prompt = 'Wait for Uma to approve OMR-12 on Jira, then merge'
    const base = {
      source: 'jira' as const,
      match: 'approve' as const,
      personId: 'emp_uma',
      since: iso(0)
    }
    expect(admitted(prompt, event({ ...base, ref: 'OMR-12' }))).toBe(true)
    expect(admitted(prompt, event({ ...base, ref: 'OMR-13' }))).toBe(false)
  })

  it("admits a session wait only when the prompt asks to wait for a session's result", () => {
    const wait = event({ source: 'session', match: 'result', ref: 'tab-2:leaf-2' })
    expect(admitted('Wait for the billing session to finish, then tell me', wait)).toBe(true)
    expect(admitted('Wait 2 minutes, then tell me', wait)).toBe(false)
  })

  it('admits time and GitHub waits only when asked, and deadlines only with a deadline clause', () => {
    expect(
      admitted(
        'Wait 2 minutes, then tell me',
        event({ source: 'time', match: 'at', at: iso(120_000) })
      )
    ).toBe(true)
    expect(
      admitted('Tell me the time', event({ source: 'time', match: 'at', at: iso(120_000) }))
    ).toBe(false)
    const pr = 'https://github.com/omnirogue/omni-ide/pull/700'
    expect(
      admitted(`Wait for ${pr} to merge`, event({ source: 'github', match: 'merged', ref: pr }))
    ).toBe(true)
    expect(
      admitted(`Wait for ${pr} to merge`, event({ source: 'github', match: 'review', ref: pr }))
    ).toBe(false)
    const withDeadline = event({
      source: 'slack',
      match: 'approve',
      personId: 'emp_uma',
      ...ask,
      deadline: iso(86_400_000),
      onDeadline: 'ask-owner'
    })
    expect(admitted(slack, withDeadline)).toBe(false)
    expect(admitted(`${slack}. If no answer by Friday, ask me`, withDeadline)).toBe(true)
  })
})

describe('a step behind a wait that continues the same conversation', () => {
  it('may carry the person’s own "then merge", which a worker could not', () => {
    const prompt = 'Wait for Uma to approve OMR-12 on Jira, then merge'
    const outcomes = (route?: 'same-session') => [
      {
        id: 'wait',
        title: 'Uma approves OMR-12',
        finish: 'complete' as const,
        dependsOn: [],
        actions: [],
        conditions: [
          {
            id: 'uma',
            kind: 'event' as const,
            target: 'Uma approves OMR-12 on Jira',
            event: {
              source: 'jira' as const,
              match: 'approve' as const,
              personId: 'emp_uma',
              ref: 'OMR-12',
              since: iso(0)
            }
          }
        ]
      },
      {
        id: 'merge',
        title: 'then merge',
        finish: 'complete' as const,
        dependsOn: ['wait'],
        conditions: [{ id: 'done', kind: 'session' as const, target: 'tab-1:leaf-1' }],
        actions: [
          {
            id: 'merge_it',
            instruction: 'then merge',
            conditionIds: ['done'],
            authority: 'existing-user-authority' as const,
            agent: 'claude' as const,
            ...(route ? { route } : {})
          }
        ]
      }
    ]
    const submit = (route?: 'same-session') =>
      validateNextOutcomeIntentSubmission(
        { expectedRevision: 0, sourcePrompt: prompt, outcomes: outcomes(route) },
        { prompt, expectedRevision: 0, outcomes: [] }
      )
    expect(() => submit('same-session')).not.toThrow()
    expect(() => submit()).toThrow()
  })
})

describe('a wait stands alone', () => {
  it('refuses a wait and its next step in one outcome, whose action would start first', () => {
    const prompt =
      'Wait for https://github.com/omnirogue/omni-ide/pull/712 to merge, then tell me it merged'
    const outcomes = [
      {
        id: 'mixed',
        title: 'Report the merge',
        finish: 'complete' as const,
        dependsOn: [],
        conditions: [
          {
            id: 'merged',
            kind: 'event' as const,
            target: 'PR 712 merged',
            event: {
              source: 'github' as const,
              match: 'merged' as const,
              ref: 'https://github.com/omnirogue/omni-ide/pull/712'
            }
          }
        ],
        actions: [
          {
            id: 'tell',
            instruction: 'tell me it merged',
            conditionIds: ['merged'],
            authority: 'existing-user-authority' as const,
            agent: 'claude' as const,
            route: 'same-session' as const
          }
        ]
      }
    ]
    expect(() =>
      validateNextOutcomeIntentSubmission(
        { expectedRevision: 0, sourcePrompt: prompt, outcomes },
        { prompt, expectedRevision: 0, outcomes: [] }
      )
    ).toThrow(/mixes a wait with work/)
  })
})
