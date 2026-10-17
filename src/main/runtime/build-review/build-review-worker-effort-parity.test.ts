import { describe, expect, it } from 'vitest'
import {
  workerEffortParityEventText,
  workerStartEffortParity
} from './build-review-worker-effort-parity'

describe('workerStartEffortParity', () => {
  it('matches when the start receipt reports the requested effort as effective', () => {
    const parity = workerStartEffortParity(
      { agent: 'claude', model: 'opus', effort: 'high' },
      {
        requested: { agent: 'claude', model: 'opus', effort: 'high' },
        effective: { agent: 'claude', model: 'opus', effort: 'high' }
      }
    )
    expect(parity.state).toBe('match')
    expect(workerEffortParityEventText(parity)).toBeNull()
  })

  it('records both values when a reviewer started at a lower effort', () => {
    const parity = workerStartEffortParity(
      { agent: 'codex', model: 'gpt-5.6-sol', effort: 'max' },
      {
        requested: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'max' },
        effective: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' }
      }
    )
    expect(parity).toMatchObject({
      state: 'mismatch',
      reason: 'effort-differs',
      requested: { effort: 'max' },
      applied: { effort: 'xhigh' }
    })
    expect(workerEffortParityEventText(parity)).toBe('Started at xhigh, not the requested max.')
  })

  it('reports an effort the model does not advertise as a refusal, not a lower level', () => {
    const parity = workerStartEffortParity(
      { agent: 'codex', model: 'gpt-5.5', effort: 'ultra' },
      { requested: { agent: 'codex', model: 'gpt-5.5', effort: 'ultra' }, effective: null }
    )
    expect(parity.state).toBe('unsupported')
    expect(parity.applied).toBeUndefined()
    expect(workerEffortParityEventText(parity)).toContain('not advertised')
    expect(workerEffortParityEventText(parity)).not.toContain('Started at')
  })

  it('reports an effort the receipt dropped entirely', () => {
    const parity = workerStartEffortParity(
      { agent: 'claude', model: 'opus', effort: 'high' },
      {
        requested: { agent: 'claude', model: 'opus', effort: 'high' },
        effective: { agent: 'claude', model: 'opus', effort: null }
      }
    )
    expect(parity).toMatchObject({ state: 'mismatch', reason: 'effort-dropped' })
    expect(workerEffortParityEventText(parity)).toBe(
      'Started with no effort applied; high was requested.'
    )
  })

  it('stays unobserved when a runtime answers without a launch receipt', () => {
    const parity = workerStartEffortParity({ agent: 'claude', model: 'opus', effort: 'high' }, null)
    expect(parity.state).toBe('unobserved')
    expect(workerEffortParityEventText(parity)).toBeNull()
  })

  it('claims nothing for a worker that asked for no model or effort', () => {
    expect(
      workerStartEffortParity({ agent: 'codex' }, { effective: { agent: 'codex' } }).state
    ).toBe('unobserved')
  })
})
