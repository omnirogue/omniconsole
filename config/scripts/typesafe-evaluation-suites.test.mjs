import { describe, expect, it } from 'vitest'
import { EVALUATION_CASES } from './typesafe-evaluation-corpus.mjs'
import { ADVERTISING_EVALUATION_CASES } from './typesafe-advertising-evaluation-corpus.mjs'
import { evaluateNumericAdvertisingReference } from './typesafe-advertising-numeric-reference.mjs'
import { resolveEvaluationSuite } from './typesafe-evaluation-suites.mjs'

describe('explicit evaluation-suite selection', () => {
  it('preserves the historical core suite and production error baseline by default', () => {
    for (const suite of [
      resolveEvaluationSuite(),
      resolveEvaluationSuite(undefined),
      resolveEvaluationSuite('core')
    ]) {
      expect(suite.id).toBe('core')
      expect(suite.cases).toBe(EVALUATION_CASES)
      expect(suite.cases).toHaveLength(48)
      expect(suite.baselineArm).toBe('existing_regex')
      expect(suite.baselineDescription).toBe('production/classifyAgentTurnFailure')
      expect(suite.baseline).toBeUndefined()
      expect(suite.limitations).toEqual([])
    }
  })

  it('opts into advertising cases without calling them production optimization evidence', () => {
    const suite = resolveEvaluationSuite('advertising')
    expect(suite.id).toBe('advertising')
    expect(suite.cases).toBe(ADVERTISING_EVALUATION_CASES)
    expect(suite.cases).not.toBe(EVALUATION_CASES)
    expect(suite.baselineArm).toBe('numeric_reference')
    expect(suite.baseline).toEqual({
      arm: 'numeric_reference',
      evaluate: evaluateNumericAdvertisingReference
    })
    expect(suite.baselineDescription).toContain('synthetic-purchase-policy.v1')
    expect(suite.baselineDescription).toContain('not the deployed optimizer')
    const disclosure = suite.limitations.join(' ')
    expect(disclosure).toContain('fictional predeclared policy')
    expect(disclosure).toContain('not proven profit outcomes')
    expect(disclosure).toContain('not the existing production advertising policy')
    expect(disclosure).toContain('not collected from a live account')
    expect(disclosure).toContain('No ad mutations')
  })

  it('keeps numerical reference applicability limited to sibling policy cases', () => {
    const suite = resolveEvaluationSuite('advertising')
    for (const item of suite.cases) {
      const result = suite.baseline.evaluate({
        capability: `evaluation_${item.task}`,
        state: item.state,
        questions: item.questions
      })
      if (item.task === 'ad_sibling_selection') {
        expect(result.status).toBe('success')
      } else {
        expect(result).toEqual({ status: 'skipped', elapsedMs: 0, errorCode: 'not_applicable' })
      }
    }
  })

  it.each(['', 'unknown', 'advertising-live', 'CORE', '../core', null, 0, {}, []])(
    'rejects an unknown or malformed suite without fallback: %j',
    (name) => {
      expect(() => resolveEvaluationSuite(name)).toThrow('evaluation_invalid_suite')
    }
  )

  it('registers bounded pairwise analysis without running a campaign simulation', () => {
    const suite = resolveEvaluationSuite('advertising_pairwise')
    expect(suite.cases).toHaveLength(48)
    expect(new Set(suite.cases.map((item) => item.familyId)).size).toBe(12)
    expect(suite.baselineArm).toBe('numeric_reference')
    expect(typeof suite.summarize).toBe('function')
    expect(suite.simulate).toBeUndefined()
    expect(suite.limitations.join(' ')).toContain('not 48 independent examples')
  })

  it('registers the profitability experiment without automatically executing it', () => {
    const suite = resolveEvaluationSuite('adset_profitability')
    expect(suite.cases).toHaveLength(48)
    expect(new Set(suite.cases.map((item) => item.familyId)).size).toBe(16)
    expect(suite.baselineArm).toBe('numeric_reference')
    expect(typeof suite.simulate).toBe('function')
    expect(suite.summarize).toBeUndefined()
    expect(suite.limitations.join(' ')).toContain('not 48 independent campaigns')
    expect(suite.limitations.join(' ')).toContain('not invented by model confidence')
  })
})
