import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JEV_RECORD_METHODS } from '../../../../shared/jev-ledger'
import type { OrcaRuntimeService } from '../../omni-runtime'
import type { RpcContext } from '../core'
import { JEV_RECORD_RPC_METHODS } from './jev-records'

const lookup = vi.hoisted(() => vi.fn())
vi.mock('../../../structured-decisions/decision-runtime', () => ({
  getStructuredDecisionRuntime: lookup
}))

const key = 'jev-call:00000000-0000-4000-8000-000000000001'
const outcome = {
  label: 1,
  evidence_level: 'cross_check',
  source: 'model_reference',
  labeler: 'session:session-123',
  blind: false
}

function method(name: string) {
  const target = JEV_RECORD_RPC_METHODS.find((entry) => entry.name === name)!
  return {
    params: target.params!,
    invoke: (params: unknown) =>
      target.handler(target.params!.parse(params), {
        runtime: {} as OrcaRuntimeService
      } as RpcContext)
  }
}

beforeEach(() => lookup.mockReset())

describe('JEV records RPC', () => {
  it('delegates list, export and outcome to the selected runtime', async () => {
    const runtime = {
      listRecords: vi.fn().mockResolvedValue({ records: [] }),
      exportRecords: vi.fn().mockResolvedValue({ rows: [], cursor: null }),
      recordOutcome: vi.fn().mockResolvedValue({ storage: { status: 'saved' } })
    }
    lookup.mockReturnValue(runtime)
    await method(JEV_RECORD_METHODS.list).invoke({ caller: 'session-owner' })
    await method(JEV_RECORD_METHODS.export).invoke({ since: '2026-10-02T00:00:00.000Z' })
    await method(JEV_RECORD_METHODS.outcome).invoke({ record_key: key, outcome })
    expect(runtime.listRecords).toHaveBeenCalledWith({ caller: 'session-owner', limit: 50 })
    expect(runtime.exportRecords).toHaveBeenCalledWith({ since: '2026-10-02T00:00:00.000Z' })
    expect(runtime.recordOutcome).toHaveBeenCalledWith({
      record_key: key,
      outcome: { ...outcome, question_id: null, correction_minutes: null, note: null }
    })
  })

  it('refuses unknown fields, other record keys and a mismatched file key', () => {
    const list = method(JEV_RECORD_METHODS.list).params
    const record = method(JEV_RECORD_METHODS.outcome).params
    expect(list.safeParse({ limit: 1001 }).success).toBe(false)
    expect(list.safeParse({ since: '2026-10-02' }).success).toBe(false)
    expect(list.safeParse({ path: '/etc' }).success).toBe(false)
    expect(record.safeParse({ record_key: 'omni-route:x', outcome }).success).toBe(false)
    expect(
      record.safeParse({ record_key: key, outcome: { ...outcome, labeler: 'a@b.example' } }).success
    ).toBe(false)
    expect(
      record.safeParse({
        record_key: key,
        outcome: { ...outcome, record_key: 'jev-call:00000000-0000-4000-8000-000000000002' }
      }).success
    ).toBe(false)
    expect(
      record.safeParse({ record_key: key, outcome: { ...outcome, schema: 'jev-outcome/1' } })
        .success
    ).toBe(true)
  })
})
