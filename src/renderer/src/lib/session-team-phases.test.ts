import { describe, expect, it } from 'vitest'
import { sessionTeamMemberDot, sessionTeamPhases, sessionTeamProgress } from './session-team-phases'
import type { SessionTeamMember } from './session-team-summary'

function member(key: string, extra: Partial<SessionTeamMember> = {}): SessionTeamMember {
  return {
    key,
    agent: 'claude',
    model: 'opus',
    effort: null,
    role: 'worker',
    state: 'planned',
    label: null,
    group: null,
    round: null,
    placement: null,
    action: 'improve',
    ...extra
  }
}

describe('sessionTeamPhases', () => {
  it('folds a fan-out into one parallel row and keeps what follows on its own row', () => {
    const phases = sessionTeamPhases([
      member('step:1', { group: 'g1', agent: 'claude' }),
      member('step:2', { group: 'g1', agent: 'codex' }),
      member('step:3', { group: 'g1', agent: 'grok' }),
      member('step:4', { action: 'synthesize' })
    ])
    expect(phases.map((phase) => [phase.parallel, phase.action, phase.members.length])).toEqual([
      [true, 'improve', 3],
      [false, 'synthesize', 1]
    ])
  })

  it('keeps one review round on one row and the next round on the next row', () => {
    const reviewer = (key: string, index: number) =>
      member(key, { role: 'reviewer', action: 'review', round: { index, total: 3 } })
    const phases = sessionTeamPhases([
      reviewer('r1', 1),
      reviewer('r2', 1),
      reviewer('r3', 2),
      reviewer('r4', 2)
    ])
    expect(phases.map((phase) => [phase.kind, phase.parallel, phase.round?.index])).toEqual([
      ['review', true, 1],
      ['review', true, 2]
    ])
  })

  it('folds sequential rounds of one action into one row that names the round under way', () => {
    const phases = sessionTeamPhases([
      member('a1', { round: { index: 1, total: 3 }, state: 'done' }),
      member('a2', { round: { index: 2, total: 3 }, state: 'working' }),
      member('a3', { round: { index: 3, total: 3 } })
    ])
    expect(phases).toHaveLength(1)
    expect(phases[0]!.parallel).toBe(false)
    expect(phases[0]!.round).toEqual({ index: 2, total: 3 })
  })

  it('never folds rounds of different agents or actions together', () => {
    const phases = sessionTeamPhases([
      member('a1', { round: { index: 1, total: 2 } }),
      member('a2', { round: { index: 2, total: 2 }, agent: 'codex' })
    ])
    expect(phases).toHaveLength(2)
  })

  it('groups live helpers of one kind and never mixes them with plan seats', () => {
    const phases = sessionTeamPhases([
      member('step:1'),
      member('pane:a', { role: 'worker', action: null }),
      member('pane:b', { role: 'worker', action: null }),
      member('subagent:x', { role: 'subagent', action: null })
    ])
    expect(phases.map((phase) => [phase.kind, phase.members.length])).toEqual([
      ['work', 1],
      ['workers', 2],
      ['subagents', 1]
    ])
  })

  it('shares an action only when every seat on the row performs it', () => {
    const [phase] = sessionTeamPhases([
      member('1', { group: 'g', action: 'review' }),
      member('2', { group: 'g', action: 'improve' })
    ])
    expect(phase!.action).toBeNull()
  })
})

describe('sessionTeamProgress', () => {
  it('counts planned, live, done and never-running seats separately', () => {
    const progress = sessionTeamProgress([
      member('1'),
      member('2', { state: 'working' }),
      member('3', { state: 'waiting' }),
      member('4', { state: 'done' }),
      member('5', { state: 'failed' }),
      member('6', { state: 'skipped' })
    ])
    expect(progress).toEqual({ total: 6, planned: 1, live: 2, done: 1, off: 2, failed: 1 })
  })
})

describe('sessionTeamMemberDot', () => {
  it('shows a planned seat as the quiet dot, never as work under way', () => {
    expect(sessionTeamMemberDot('planned')).toBe('idle')
    expect(sessionTeamMemberDot('working')).toBe('working')
    expect(sessionTeamMemberDot('failed')).toBe('failed')
    expect(sessionTeamMemberDot('cancelled')).toBe('idle')
  })
})
