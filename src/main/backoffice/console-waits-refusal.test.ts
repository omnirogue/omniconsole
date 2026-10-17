import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.fn()
vi.mock('./console-workflow-transport', () => ({
  requestConsoleWorkflow: (...args: unknown[]) => request(...args),
  validated: (value: unknown, _schema: unknown, send: (args: unknown) => unknown) => send(value)
}))

import { askConsoleWait, readConsoleWaitFacts } from './console-waits-client'

const query = {
  source: 'slack' as const,
  personId: 'emp_uma',
  ref: 'slack:D1:1',
  since: '2026-09-24T16:00:00.000Z',
  match: 'approve' as const
}

beforeEach(() => request.mockReset())

describe('omnios wait refusals', () => {
  it('reads a 404 as a missing route only when omnios sent no code of its own', async () => {
    request.mockResolvedValueOnce({
      ok: false,
      error: { code: 'person_not_on_roster', message: 'Uma is not on the roster.', status: 404 }
    })
    await expect(askConsoleWait({})).rejects.toThrow(
      'omnios refused the ask: Uma is not on the roster.'
    )
    request.mockResolvedValueOnce({
      ok: false,
      error: { code: 'capability_unavailable', message: 'Not Found', status: 404 }
    })
    await expect(askConsoleWait({})).rejects.toThrow('omnios does not accept wait asks yet.')
    request.mockResolvedValueOnce({
      ok: false,
      error: { code: 'capability_unavailable', message: 'Not Found', status: 404 }
    })
    expect(await readConsoleWaitFacts(query)).toEqual({
      status: 'unavailable',
      reason: 'omnios does not serve wait facts yet.'
    })
  })

  it('passes omnios’s own unavailable reason through as-is', async () => {
    request.mockResolvedValueOnce({
      ok: true,
      data: { status: 'unavailable', reason: 'the estate broker is paused', checked_at: 'x' }
    })
    expect(await readConsoleWaitFacts(query)).toMatchObject({
      status: 'unavailable',
      reason: 'the estate broker is paused'
    })
  })
})
