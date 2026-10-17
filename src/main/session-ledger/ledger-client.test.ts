import { describe, expect, it, vi } from 'vitest'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import {
  createSessionLedgerClient,
  OMNI_TIMEZONE_HEADER,
  type LedgerTransport
} from './ledger-client'

vi.mock('../backoffice/console-workflow-person', () => ({
  currentConsolePublicationScope: () => null
}))
vi.mock('../backoffice/console-workflow-transport', () => ({ requestConsoleWorkflow: vi.fn() }))

const BATCH = {
  ledger_id: 'als_0123456789abcdef01234567',
  attempt_id: 'att_0123456789abcdef',
  app: 'omni-ide' as const,
  started_at: 't',
  events: []
}

function transport(answer: ConsoleWorkflowResult<unknown>) {
  const calls: unknown[][] = []
  const request = vi.fn(async (...args: unknown[]) => {
    calls.push(args)
    return answer
  }) as unknown as LedgerTransport
  return { request, calls }
}

describe('ledger client account binding', () => {
  it('passes the batch account and a same-account check to the transport for events and register', async () => {
    let current = 'acct-a'
    const { request, calls } = transport({ ok: true, data: { accepted: 1 } })
    const client = createSessionLedgerClient(request, () => current)
    await client.events(BATCH, 'acct-a')
    await client.register(BATCH.ledger_id, { waiting: true }, 'acct-a')
    for (const call of calls) {
      expect(call[6]).toBe('acct-a')
      const isCurrent = call[7] as () => boolean
      expect(isCurrent()).toBe(true)
      current = 'acct-b'
      expect(isCurrent()).toBe(false)
      current = 'acct-a'
    }
  })

  it.each(['principal_mismatch', 'connection_changed'])('maps %s to a held send', async (code) => {
    const { request } = transport({ ok: false, error: { code, message: 'no' } })
    const client = createSessionLedgerClient(request, () => 'acct-a')
    expect(await client.events(BATCH, 'acct-a')).toEqual({
      ok: false,
      reason: 'principal-mismatch'
    })
    expect(await client.register(BATCH.ledger_id, { waiting: false }, 'acct-a')).toEqual({
      ok: false,
      reason: 'principal-mismatch'
    })
  })

  it.each([
    [400, 'rejected'],
    [401, 'signed-out'],
    [403, 'signed-out'],
    [404, 'rejected'],
    [422, 'rejected'],
    [408, 'unavailable'],
    [429, 'unavailable'],
    [503, 'unavailable']
  ])('maps a %s on events and register alike to %s', async (status, reason) => {
    const { request } = transport({
      ok: false,
      error: { code: 'http_error', message: 'no', status }
    })
    const client = createSessionLedgerClient(request, () => 'acct-a')
    expect(await client.events(BATCH, 'acct-a')).toEqual({ ok: false, reason })
    expect(await client.register(BATCH.ledger_id, { waiting: false }, 'acct-a')).toEqual({
      ok: false,
      reason
    })
  })

  it('reads peers with their employee_id when the console sends it', async () => {
    const { request } = transport({
      ok: true,
      data: {
        peers: [
          {
            ledger_id: 'als_aaaaaaaaaaaaaaaaaaaaaaaa',
            employee_id: 'emp_uma',
            reason: 'same card btk_1'
          }
        ]
      }
    })
    const client = createSessionLedgerClient(request, () => 'acct-a')
    expect(await client.peers(BATCH.ledger_id)).toEqual({
      ok: true,
      peers: [
        {
          ledger_id: 'als_aaaaaaaaaaaaaaaaaaaaaaaa',
          employee_id: 'emp_uma',
          reason: 'same card btk_1'
        }
      ]
    })
  })
})

describe('ledger client timezone', () => {
  it('sends the process timezone on now and peers reads (and on writes)', async () => {
    const { request, calls } = transport({
      ok: true,
      data: { rows: [], overflow: 0, server_time: 't', peers: [] }
    })
    const client = createSessionLedgerClient(request, () => 'acct-a')
    await client.now('today')
    await client.peers(BATCH.ledger_id)
    await client.events(BATCH, 'acct-a')
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(zone).toBeTruthy()
    expect(calls[0]?.[1]).toBe('GET')
    for (const call of calls) {
      expect(call[9]).toEqual({ [OMNI_TIMEZONE_HEADER]: zone })
    }
  })
})
