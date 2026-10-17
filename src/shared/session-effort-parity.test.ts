import { describe, expect, it } from 'vitest'
import {
  evaluateSessionEffortParity,
  isSessionEffortParityDivergent,
  normalizeSessionEffortParity,
  sessionEffortParityBlocksSend,
  sessionEffortParityKey,
  sessionEffortParityValues
} from './session-effort-parity'
import { supportedEffortsForAgentModel } from './session-effort-support'

describe('evaluateSessionEffortParity', () => {
  it('matches when the provider reported the requested effort', () => {
    const parity = evaluateSessionEffortParity({
      requested: { model: 'opus', effort: 'high' },
      applied: { model: 'opus', effort: 'high' }
    })
    expect(parity.state).toBe('match')
    expect(parity.reason).toBeUndefined()
    expect(isSessionEffortParityDivergent(parity)).toBe(false)
    expect(sessionEffortParityBlocksSend(parity)).toBe(false)
  })

  it('reports a mismatch with both values when the provider lowered the effort', () => {
    const parity = evaluateSessionEffortParity({
      requested: { model: 'gpt-5.6-sol', effort: 'max' },
      applied: { model: 'gpt-5.6-sol', effort: 'xhigh' }
    })
    expect(parity).toMatchObject({
      state: 'mismatch',
      reason: 'effort-differs',
      requested: { effort: 'max' },
      applied: { effort: 'xhigh' }
    })
    expect(sessionEffortParityBlocksSend(parity)).toBe(true)
  })

  it('reports a dropped effort rather than calling it a match', () => {
    const parity = evaluateSessionEffortParity({
      requested: { model: 'opus', effort: 'xhigh' },
      applied: { model: 'opus' }
    })
    expect(parity).toMatchObject({ state: 'mismatch', reason: 'effort-dropped' })
  })

  it('names the model as the cause when the model itself changed', () => {
    const parity = evaluateSessionEffortParity({
      requested: { model: 'opus', effort: 'high' },
      applied: { model: 'sonnet', effort: 'medium' }
    })
    expect(parity).toMatchObject({ state: 'mismatch', reason: 'model-differs' })
  })

  it('refuses an unsupported effort instead of clamping it, before anything is observed', () => {
    const parity = evaluateSessionEffortParity({
      requested: { model: 'gpt-5.5', effort: 'ultra' },
      supportedEfforts: supportedEffortsForAgentModel('codex', 'gpt-5.5')
    })
    expect(parity).toMatchObject({
      state: 'unsupported',
      reason: 'effort-unsupported',
      requested: { effort: 'ultra' }
    })
    // The refusal never names a lower level as the outcome.
    expect(parity.applied).toBeUndefined()
    expect(sessionEffortParityBlocksSend(parity)).toBe(true)
  })

  it('treats an unknown level set as unknown, never as unsupported', () => {
    expect(
      evaluateSessionEffortParity({
        requested: { model: 'mystery', effort: 'ultra' },
        applied: { model: 'mystery', effort: 'ultra' },
        supportedEfforts: null
      }).state
    ).toBe('match')
    expect(
      evaluateSessionEffortParity({
        requested: { effort: 'ultra' },
        supportedEfforts: []
      }).state
    ).toBe('unobserved')
  })

  it('tells "nothing was applied" apart from "nothing was observed"', () => {
    // An applied object, even an empty one, is the caller reporting what the launch carried.
    expect(
      evaluateSessionEffortParity({ requested: { effort: 'xhigh' }, applied: {} })
    ).toMatchObject({ state: 'mismatch', reason: 'effort-dropped' })
    expect(evaluateSessionEffortParity({ requested: { effort: 'xhigh' } }).state).toBe('unobserved')
    expect(
      evaluateSessionEffortParity({ requested: { effort: 'xhigh' }, applied: null }).state
    ).toBe('unobserved')
  })

  it('stays unobserved until something is both requested and reported', () => {
    expect(evaluateSessionEffortParity({ requested: { effort: 'high' } }).state).toBe('unobserved')
    expect(evaluateSessionEffortParity({ applied: { effort: 'high' } }).state).toBe('unobserved')
    expect(evaluateSessionEffortParity({ requested: { effort: '  ' } }).state).toBe('unobserved')
  })

  it('lets an accepted divergence stop blocking the send without losing either value', () => {
    const parity = evaluateSessionEffortParity({
      requested: { effort: 'high' },
      applied: { effort: 'low' }
    })
    expect(sessionEffortParityBlocksSend(parity, true)).toBe(false)
    expect(parity.requested?.effort).toBe('high')
    expect(parity.applied?.effort).toBe('low')
  })

  it('keys each divergence separately so accepting one does not accept the next', () => {
    const first = evaluateSessionEffortParity({
      requested: { effort: 'high' },
      applied: { effort: 'low' }
    })
    const second = evaluateSessionEffortParity({
      requested: { effort: 'high' },
      applied: { effort: 'medium' }
    })
    expect(sessionEffortParityKey(first)).not.toBe(sessionEffortParityKey(second))
  })
})

describe('sessionEffortParityValues', () => {
  it('names the efforts for an effort divergence and never a model as the effort', () => {
    expect(
      sessionEffortParityValues(
        evaluateSessionEffortParity({
          requested: { model: 'opus', effort: 'xhigh' },
          applied: { model: 'opus' }
        })
      )
    ).toEqual({ requested: 'xhigh' })
  })

  it('names the models for a model divergence', () => {
    expect(
      sessionEffortParityValues(
        evaluateSessionEffortParity({
          requested: { model: 'opus', effort: 'high' },
          applied: { model: 'sonnet', effort: 'high' }
        })
      )
    ).toEqual({ requested: 'opus', applied: 'sonnet' })
  })
})

describe('normalizeSessionEffortParity', () => {
  it('round-trips a persisted record', () => {
    const parity = evaluateSessionEffortParity({
      requested: { model: 'opus', effort: 'xhigh' },
      applied: { model: 'opus', effort: 'high' }
    })
    expect(normalizeSessionEffortParity(JSON.parse(JSON.stringify(parity)))).toEqual(parity)
  })

  it('drops a shape it cannot prove', () => {
    expect(normalizeSessionEffortParity(null)).toBeNull()
    expect(normalizeSessionEffortParity({ state: 'nonsense' })).toBeNull()
    expect(normalizeSessionEffortParity({ state: 'mismatch', requested: 'high' })).toEqual({
      state: 'mismatch'
    })
  })
})

describe('supportedEffortsForAgentModel', () => {
  it('reads each model advertised ceiling from the existing catalog', () => {
    expect(supportedEffortsForAgentModel('codex', 'gpt-5.5')).not.toContain('ultra')
    expect(supportedEffortsForAgentModel('codex', 'gpt-5.6-sol')).toContain('ultra')
    expect(supportedEffortsForAgentModel('claude', 'opus')).toContain('xhigh')
  })

  it('returns null when nothing advertises a level set', () => {
    expect(supportedEffortsForAgentModel('claude', 'haiku')).toBeNull()
    expect(supportedEffortsForAgentModel('not-an-agent', 'opus')).toBeNull()
  })
})
