import { describe, expect, it } from 'vitest'
import {
  anyGroupExpression,
  groupMatchExpression,
  highlightPattern,
  planSessionSearchQuery,
  prefixStem,
  proximityExpression
} from './session-search-query'

describe('planSessionSearchQuery', () => {
  it('matches a URL as one phrase without its scheme', () => {
    const plan = planSessionSearchQuery('https://app.omnisi.ai/a/1a0d42a7df36eefc2')
    expect(plan.groups).toHaveLength(1)
    expect(plan.groups[0]!.kind).toBe('phrase')
    expect(groupMatchExpression(plan.groups[0]!)).toBe('"omnios omnirogue com a 1a0d42a7df36eefc2"')
  })

  it('treats abbreviations as the same word and prefix-matches typed words', () => {
    const plan = planSessionSearchQuery('omnirogue production')
    expect(plan.groups.map(groupMatchExpression)).toEqual([
      '"omnirogue"*',
      '("production"* OR "prod")'
    ])
    expect(plan.groups[1]!.expansions).toEqual(['prod'])
  })

  it('keeps quoted text together and drops stopwords', () => {
    const plan = planSessionSearchQuery('"side menu" for the uma')
    expect(plan.groups.map((group) => group.label)).toEqual(['side menu', 'uma'])
  })

  it('keeps identifiers and PR numbers exact-or-prefix', () => {
    const plan = planSessionSearchQuery('#1116 86065e26')
    expect(plan.groups.map((group) => group.kind)).toEqual(['identifier', 'identifier'])
  })

  it('cannot be broken out of its quotes by FTS syntax', () => {
    const expression = anyGroupExpression(planSessionSearchQuery('a" OR NEAR(x) *'))
    expect(expression).not.toContain('NEAR(x')
    expect(expression.split('"').length % 2).toBe(1)
  })

  it('builds a proximity expression only for two to four terms', () => {
    expect(proximityExpression(planSessionSearchQuery('uma'))).toBeNull()
    expect(proximityExpression(planSessionSearchQuery('omnirogue production'))).toBe(
      'NEAR("omnirogue"* "production"*, 4) OR NEAR("omnirogue"* "prod", 4)'
    )
  })

  it('highlights hyphenated forms of a phrase', () => {
    const pattern = highlightPattern(planSessionSearchQuery('"prod omnirogue"'))!
    expect('deploy to prod-omnirogue now'.match(pattern)?.[0]).toBe('prod-omnirogue')
  })
})

describe('prefixStem', () => {
  it('trims common suffixes but leaves short words and IDs alone', () => {
    expect(prefixStem('deployment')).toBe('deploy')
    expect(prefixStem('sessions')).toBe('session')
    expect(prefixStem('menu')).toBe('menu')
    expect(prefixStem('pr1116s')).toBe('pr1116s')
  })
})
