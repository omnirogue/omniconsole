import { describe, expect, it } from 'vitest'
import { resolveSessionActorLaunch } from './session-actor'
import { evaluateSessionEffortParity } from '../../../shared/session-effort-parity'
import { supportedEffortsForAgentModel } from '../../../shared/session-effort-support'
import { normalizeSessionChainStep } from '../../../shared/session-chain-normalize'
import type { SessionChainAgentStep } from '../../../shared/session-chain-types'

/** Exactly what session-chain-launch records when a step launches. */
function stepParity(step: { agent: 'claude' | 'codex'; model?: string; effort?: string }) {
  const { launchPreferences } = resolveSessionActorLaunch(null, step.agent, {
    ...(step.model ? { model: step.model } : {}),
    ...(step.effort ? { effort: step.effort } : {})
  })
  return evaluateSessionEffortParity({
    requested: {
      ...(step.model ? { model: step.model } : {}),
      ...(step.effort ? { effort: step.effort } : {})
    },
    applied: {
      ...(launchPreferences?.model ? { model: launchPreferences.model } : {}),
      ...(launchPreferences?.effort ? { effort: launchPreferences.effort } : {})
    },
    supportedEfforts: supportedEffortsForAgentModel(step.agent, step.model)
  })
}

describe('chain step requested vs applied effort', () => {
  it('matches when the step launches with the model and effort it asked for', () => {
    expect(stepParity({ agent: 'claude', model: 'opus', effort: 'high' })).toMatchObject({
      state: 'match',
      requested: { model: 'opus', effort: 'high' },
      applied: { model: 'opus', effort: 'high' }
    })
  })

  it('records the effort the launch contract drops when a step names no model', () => {
    expect(stepParity({ agent: 'claude', effort: 'xhigh' })).toMatchObject({
      state: 'mismatch',
      reason: 'effort-dropped',
      requested: { effort: 'xhigh' }
    })
  })

  it('refuses a level the step model does not advertise instead of stepping it down', () => {
    const parity = stepParity({ agent: 'codex', model: 'gpt-5.5', effort: 'ultra' })
    expect(parity).toMatchObject({ state: 'unsupported', reason: 'effort-unsupported' })
    expect(parity.applied?.effort).toBe('ultra')
  })
})

describe('normalizeSessionChainStep', () => {
  it('reads a step parity record back from disk', () => {
    const step: SessionChainAgentStep = {
      id: 'step_1',
      agent: 'claude',
      prompt: 'do the thing',
      model: 'opus',
      effort: 'xhigh',
      effortParity: {
        state: 'mismatch',
        reason: 'effort-differs',
        requested: { model: 'opus', effort: 'xhigh' },
        applied: { model: 'opus', effort: 'high' }
      },
      status: 'launched'
    }
    const read = normalizeSessionChainStep(JSON.parse(JSON.stringify(step)))
    expect(read).not.toBeNull()
    expect(read && 'effortParity' in read ? read.effortParity : null).toEqual(step.effortParity)
  })

  it('drops a parity record it cannot prove rather than inventing one', () => {
    const read = normalizeSessionChainStep({
      id: 'step_1',
      agent: 'claude',
      prompt: 'do the thing',
      status: 'queued',
      effortParity: { state: 'invented' }
    })
    expect(read && 'effortParity' in read ? read.effortParity : undefined).toBeUndefined()
  })
})
