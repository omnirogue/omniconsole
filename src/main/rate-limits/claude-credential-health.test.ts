import { describe, expect, it } from 'vitest'
import {
  canMaterializeClaudeCredential,
  claudeCredentialHealth,
  orderClaudeWorkingSources,
  type ClaudeSourceCandidate
} from './claude-credential-health'
const source = (
  kind: ClaudeSourceCandidate['kind'],
  accessUsable = false,
  refreshUsable = true
): ClaudeSourceCandidate => ({
  kind,
  path: kind,
  accessUsable,
  refreshUsable,
  expired: !accessUsable
})
describe('Claude working credential ownership', () => {
  it('excludes managed credentials when non-pool or pool seats exist', () => {
    expect(
      orderClaudeWorkingSources([source('pool'), source('managed', true), source('seat')]).map(
        (s) => s.kind
      )
    ).toEqual(['seat', 'pool'])
  })
  it('never refreshes managed credentials while any same-identity seat exists, even expired', () => {
    expect(
      orderClaudeWorkingSources([
        source('session', true),
        source('managed', true),
        source('seat', false, false)
      ])
    ).toEqual([])
    expect(orderClaudeWorkingSources([source('managed'), source('seat', false, false)])).toEqual([])
    expect(orderClaudeWorkingSources([source('managed')])).toEqual([])
    expect(orderClaudeWorkingSources([source('session')]).map((s) => s.kind)).toEqual(['session'])
  })
  it('does not call an expired access token usable', () => {
    expect(
      claudeCredentialHealth(
        JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic', expiresAt: 1 } }),
        2
      ).accessUsable
    ).toBe(false)
    expect(claudeCredentialHealth('{}').accessUsable).toBe(false)
  })
  it('never materializes expired, gutted, or seat-owned credentials', () => {
    expect(canMaterializeClaudeCredential(source('managed'), false)).toBe(false)
    expect(canMaterializeClaudeCredential(claudeCredentialHealth('{}'), false)).toBe(false)
    expect(canMaterializeClaudeCredential(source('managed', true), true)).toBe(false)
    expect(canMaterializeClaudeCredential(source('managed', true), false)).toBe(true)
  })
})

it('prefers an access-usable pool over a refresh-only seat', () => {
  expect(
    orderClaudeWorkingSources([source('seat'), source('pool', true)]).map((s) => s.kind)
  ).toEqual(['pool', 'seat'])
})
