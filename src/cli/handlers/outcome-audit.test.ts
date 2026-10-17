import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRunAuditRow } from '../../shared/session-run-audit'
import type { HandlerContext } from '../dispatch'
import { OUTCOME_HANDLERS } from './outcome'
import { formatOutcomeAudit } from './outcome-audit'

const STALL = 'No activity was observed for 180s, so the agent was treated as stalled.'
const row: SessionRunAuditRow = {
  chainId: 'source_abc',
  title: 'Ship the report',
  state: 'waiting',
  phase: 'failed',
  findings: ['unclassified-block', 'state-disagrees-with-phase'],
  repair: 'classify',
  reasons: [`Ship the report: ${STALL}`],
  updatedAt: 5
}

const response = (result: unknown) => ({ id: 'rpc', ok: true, result })
function setup(rows: SessionRunAuditRow[], json: boolean, executionRuntimeId?: string) {
  const call = vi.fn(async (method: string, _params?: unknown) => {
    if (method === 'sessionChain.outcomeCapabilities') {
      return response({ version: 1, durableContinuation: true, executionRuntimeId })
    }
    if (method === 'sessionChain.auditRuns') {
      return response({ rows })
    }
    throw new Error(`Unexpected RPC ${method}`)
  })
  const context = {
    client: { call },
    flags: new Map(),
    cwd: '/work',
    json
  } as unknown as HandlerContext
  return { call, context }
}

let log: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('omni outcome audit', () => {
  it('reads the audit from the execution host it negotiated with, and changes nothing', async () => {
    const { call, context } = setup([row], true, 'incarnation')
    await OUTCOME_HANDLERS['outcome audit'](context)
    expect(call.mock.calls.map((entry) => [entry[0], entry[1]])).toEqual([
      ['sessionChain.outcomeCapabilities', undefined],
      ['sessionChain.auditRuns', { expectedExecutionRuntimeId: 'incarnation' }]
    ])
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      ok: true,
      result: { rows: [row] }
    })
  })

  it('says what each stranded run is, reads as, and what reconciliation will do', async () => {
    const { context } = setup([row], false)
    await OUTCOME_HANDLERS['outcome audit'](context)
    const printed = log.mock.calls[0]![0] as string
    expect(printed).toContain('source_abc  Ship the report')
    expect(printed).toContain('recorded waiting, reads as failed')
    expect(printed).toContain('unclassified-block, state-disagrees-with-phase')
    expect(printed).toContain('reconciliation will: classify')
    expect(printed).toContain(STALL)
  })

  it('says so when every run agrees with its record', () => {
    expect(formatOutcomeAudit([])).toBe('Every pursued session agrees with its own record.')
  })
})
