import { describe, expect, it } from 'vitest'
import type { CatalogModel } from '../../../shared/agent-session-option-catalog'
import type { LocalWorkflowSeatCapacity } from '../../../shared/local-workflow-seat-capacity'
import {
  resolveLocalWorkflowSeat,
  type LocalWorkflowSeatCatalog
} from '../../../shared/local-workflow-seats'
import { SEAT_RULES } from './graph/graph-seat-substitution'
import { admitGraphSeatRules } from './local-workflow-graph-seat-admission'

function entry(
  agent: LocalWorkflowSeatCatalog['agent'],
  accountId: string,
  capacity?: LocalWorkflowSeatCapacity,
  change: Partial<LocalWorkflowSeatCatalog> = {}
): LocalWorkflowSeatCatalog {
  return {
    agent,
    accountId,
    accountLabel: accountId === 'system:codex' ? 'System Codex' : accountId,
    accountHome: `/homes/${accountId}`,
    policyRevision: `p-${accountId}`,
    ...(capacity ? { capacity } : {}),
    models: [
      {
        catalog: { id: `${agent}-model`, isDefault: true, options: [] } as unknown as CatalogModel,
        resolvedModelId: `${agent}-model-resolved`,
        lineage: agent === 'claude' ? 'anthropic' : 'openai'
      }
    ],
    ...change
  }
}

const CATALOG = [
  entry('claude', 'system:claude', { state: 'fresh', remainingPercent: 80 }),
  entry('codex', 'system:codex', { state: 'limited' }),
  entry('codex', 'managed:m1', { state: 'fresh', remainingPercent: 94 }),
  entry('codex', 'managed:m2', undefined, { unavailableReason: 'Signed out.' })
]

describe('seat rules frozen at admission', () => {
  it('keeps a chosen seat as it is, names its unverified account, and freezes fresh spares', () => {
    // The person (or a saved spec) chose System Codex: the run keeps it, and says so.
    const codex = resolveLocalWorkflowSeat(
      { id: 'codex', agent: 'codex', accountId: 'system:codex' },
      CATALOG
    )
    const claude = resolveLocalWorkflowSeat(
      { id: 'claude', agent: 'claude', accountId: 'system:claude' },
      CATALOG
    )
    const seats = [claude, codex]
    const before = structuredClone(seats)
    const fields = admitGraphSeatRules(seats, CATALOG)
    expect(seats).toEqual(before)
    expect(fields.seatRules).toBe(SEAT_RULES)
    expect(fields.seatNotes).toEqual([
      'Codex ran on System Codex, which was at its usage limit when the run started; its remaining capacity was not verified.'
    ])
    // Same model and effort on the other eligible Codex account, verified like any seat.
    expect(fields.spareSeats).toEqual([
      {
        ...codex,
        id: 'codex@managed:m1',
        accountId: 'managed:m1',
        policyRevision: 'p-managed:m1'
      }
    ])
  })

  it('says every unverified account once and freezes no spare where there is none', () => {
    const catalog = [entry('claude', 'system:claude'), entry('codex', 'system:codex')]
    const seats = [
      resolveLocalWorkflowSeat(
        { id: 'claude', agent: 'claude', accountId: 'system:claude' },
        catalog
      ),
      resolveLocalWorkflowSeat({ id: 'codex', agent: 'codex', accountId: 'system:codex' }, catalog)
    ]
    const fields = admitGraphSeatRules(seats, catalog)
    expect(fields.spareSeats).toEqual([])
    expect(fields.seatNotes).toEqual([
      'Claude ran on system:claude, which had no usage reading when the run started; its remaining capacity was not verified.',
      'Codex ran on System Codex, which had no usage reading when the run started; its remaining capacity was not verified.'
    ])
  })
})
