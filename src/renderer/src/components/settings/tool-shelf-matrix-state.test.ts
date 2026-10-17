import { describe, expect, it } from 'vitest'
import type {
  AccessSectionSummary,
  PrincipalSummary
} from '../../../../shared/console-access-contract'
import {
  cellFor,
  cellIntent,
  cellIsChangeable,
  cellState,
  orderedPrincipals,
  overrideForRef
} from './tool-shelf-matrix-state'

const finance: AccessSectionSummary = {
  key: 'finance',
  label: 'Finance',
  groups: ['payments'],
  read_ref: '@section:finance:read',
  write_ref: '@section:finance:write',
  read_count: 12,
  write_count: 7,
  floor_count: 3
}

function person(overrides: Partial<PrincipalSummary> = {}): PrincipalSummary {
  return {
    principal: 'human:emp_shona',
    kind: 'human',
    overrides: [],
    ...overrides
  } as PrincipalSummary
}

const grant = {
  id: 'apl_abcd1234',
  principal: 'human:emp_shona',
  action: 'grant' as const,
  capability: '@section:finance:read',
  reason: 'ACME invoices',
  issued_by: 'emp_sal',
  expires_at: null,
  expired: false
}

describe('a cell of the people × sections matrix', () => {
  it('reads on, off and partial from the effective counts', () => {
    expect(cellState(12, 12, 0)).toBe('on')
    expect(cellState(0, 12, 0)).toBe('off')
    expect(cellState(4, 12, 0)).toBe('partial')
  })

  it('says floor — never off — when the section has only ungrantable writes', () => {
    expect(cellState(0, 0, 3)).toBe('floor')
    expect(cellState(0, 0, 0)).toBe('empty')
    expect(cellIsChangeable({ ...cellFor(person(), finance, 'read'), state: 'floor' })).toBe(false)
  })

  it('takes the counts from the principal’s own section state', () => {
    const row = person({
      sections: { finance: { read: { granted: 12, total: 12 }, write: { granted: 2, total: 7 } } }
    })
    expect(cellFor(row, finance, 'read')).toMatchObject({
      state: 'on',
      granted: 12,
      total: 12,
      ref: '@section:finance:read'
    })
    expect(cellFor(row, finance, 'write')).toMatchObject({
      state: 'partial',
      ref: '@section:finance:write'
    })
  })

  it('falls back to no grant at all when the hub reports no section state', () => {
    expect(cellFor(person(), finance, 'read')).toMatchObject({
      state: 'off',
      granted: 0,
      total: 12
    })
  })

  it('puts humans above agent roles', () => {
    const rows = orderedPrincipals([
      person({ principal: 'agent:luna-scout', kind: 'agent' }),
      person({ principal: 'human:emp_sal' }),
      person({ principal: 'human:emp_gamma' })
    ])
    expect(rows.map((row) => row.principal)).toEqual([
      'human:emp_gamma',
      'human:emp_sal',
      'agent:luna-scout'
    ])
  })
})

describe('what a click on a cell writes', () => {
  const digest = 'abcdef0123456789'

  it('grants the section ref when turning an off cell on', () => {
    const cell = cellFor(person(), finance, 'read')
    expect(cellIntent(cell, [], digest, 'month end', '2026-12-31')).toEqual({
      turning: 'on',
      change: {
        op: 'grant',
        capability: '@section:finance:read',
        reason: 'month end',
        expected_digest: digest,
        expires_at: '2026-12-31'
      }
    })
  })

  it('grants the rest of a partial cell rather than denying it', () => {
    const row = person({
      sections: { finance: { read: { granted: 4, total: 12 }, write: { granted: 0, total: 7 } } }
    })
    const intent = cellIntent(cellFor(row, finance, 'read'), [], digest, 'month end')
    expect(intent.turning).toBe('on')
    expect(intent.change.op).toBe('grant')
  })

  it('withdraws the standing grant instead of stacking a deny on it', () => {
    const row = person({
      sections: { finance: { read: { granted: 12, total: 12 }, write: { granted: 0, total: 7 } } },
      overrides: [grant]
    })
    expect(
      cellIntent(cellFor(row, finance, 'read'), row.overrides, digest, 'left the team')
    ).toEqual({
      turning: 'off',
      change: { op: 'remove', override_id: 'apl_abcd1234', expected_digest: digest }
    })
  })

  it('denies when the cell is on for a reason no override of ours explains', () => {
    const row = person({
      sections: { finance: { read: { granted: 12, total: 12 }, write: { granted: 0, total: 7 } } }
    })
    expect(cellIntent(cellFor(row, finance, 'read'), [], digest, 'left the team').change).toEqual({
      op: 'deny',
      capability: '@section:finance:read',
      reason: 'left the team',
      expected_digest: digest
    })
  })

  it('withdraws a standing deny when turning the cell back on', () => {
    const deny = { ...grant, action: 'deny' as const, id: 'apl_deny0001' }
    const intent = cellIntent(
      cellFor(person(), finance, 'read'),
      [deny],
      digest,
      'back on the team'
    )
    expect(intent.change).toEqual({
      op: 'remove',
      override_id: 'apl_deny0001',
      expected_digest: digest
    })
  })

  it('ignores an expired row when reading who decided a cell', () => {
    expect(overrideForRef([{ ...grant, expired: true }], '@section:finance:read')).toBeNull()
    expect(overrideForRef([grant], '@section:finance:read')?.id).toBe('apl_abcd1234')
    expect(overrideForRef([grant], '@section:finance:write')).toBeNull()
  })
})
