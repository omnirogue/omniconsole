import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'

const request = vi.fn()
vi.mock('./console-workflow-transport', () => ({
  requestConsoleWorkflow: (...args: unknown[]) => request(...args)
}))
vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: async () => ({
    ok: true,
    data: { principal: 'p', isCurrent: () => true }
  })
}))
vi.mock('../session-ledger/ledger-lookup', () => ({
  ledgerSourceForSession: (key: string) =>
    key === 'pane' ? { ledgerId: `als_${'a'.repeat(24)}` } : null
}))

import { publishSessionWaits, resetPublishedSessionWaitsForTest } from './console-session-waits'

const summary = {
  version: 1,
  revision: 7,
  visibility: 'company',
  company_key: 'OMR',
  division: 'Marketing',
  purpose: 'Upgrade Iris',
  progress: 'asked',
  next_action: 'wait',
  responsible_actor: 'Sal',
  work_ref: null,
  parent_ledger_id: null,
  outcome_refs: [],
  handoff_refs: []
}

function chain(status: 'pending' | 'needs_you' | 'unavailable' = 'pending'): SessionChain {
  return {
    id: 'c1',
    state: 'waiting',
    sourcePaneKey: 'pane',
    outcomeSet: {
      outcomes: [
        {
          id: 'w',
          revision: 1,
          evidence: [],
          conditions: [
            {
              id: 'u',
              kind: 'event',
              target: 'Uma approves on Slack',
              event: { source: 'slack', match: 'approve', personId: 'emp_uma' }
            }
          ],
          waits: [{ conditionId: 'u', status, checkedAt: 1 }]
        }
      ]
    }
  } as unknown as SessionChain
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

async function publishNow(status: 'pending' | 'needs_you' | 'unavailable'): Promise<number> {
  request.mockClear()
  publishSessionWaits(chain(status))
  await flush()
  await flush()
  return request.mock.calls.filter(([, method]) => method === 'POST').length
}

beforeEach(() => {
  resetPublishedSessionWaitsForTest()
  request.mockReset()
  request.mockImplementation(async (_path: string, method: string) =>
    method === 'GET'
      ? { ok: true, data: { session: { ledger_id: 'x', app: 'omni-ide', work_summary: summary } } }
      : { ok: true, data: { ok: true, row: {} } }
  )
})

describe('publishSessionWaits', () => {
  it('writes the whole summary back with the waits, and only when the list changes', async () => {
    publishSessionWaits(chain())
    await flush()
    await flush()
    const post = request.mock.calls.find(([, method]) => method === 'POST')!
    expect(post[0]).toBe(`/api/agent-sessions/als_${'a'.repeat(24)}/register`)
    const { revision: _revision, ...kept } = summary
    expect(post[3]).toEqual({
      work_summary: {
        ...kept,
        expected_revision: 7,
        waits: [
          {
            label: 'Uma approves on Slack',
            source: 'slack',
            status: 'pending',
            checked_at: new Date(1).toISOString(),
            person_id: 'emp_uma'
          }
        ]
      }
    })
    request.mockClear()
    publishSessionWaits(chain())
    await flush()
    await flush()
    expect(request).not.toHaveBeenCalled()
    publishSessionWaits(chain('needs_you'))
    await flush()
    await flush()
    expect(request.mock.calls.some(([, method]) => method === 'POST')).toBe(true)
  })

  it('reads again and retries once when someone else saved in between', async () => {
    let posts = 0
    request.mockImplementation(async (_path: string, method: string) => {
      if (method === 'GET') {
        return {
          ok: true,
          data: { session: { ledger_id: 'x', app: 'omni-ide', work_summary: summary } }
        }
      }
      posts += 1
      return posts === 1
        ? { ok: false, error: { code: 'work-summary-conflict', message: 'conflict', status: 409 } }
        : { ok: true, data: { ok: true, row: {} } }
    })
    publishSessionWaits(chain())
    for (let index = 0; index < 5; index++) {
      await flush()
    }
    expect(posts).toBe(2)
  })

  it('does not write an omnios redeploy: a flip to unavailable counts only once it lasts', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    expect(await publishNow('pending')).toBe(1)
    expect(await publishNow('unavailable')).toBe(0)
    expect(await publishNow('pending')).toBe(0)
    expect(await publishNow('unavailable')).toBe(0)
    now.mockReturnValue(1_000_000 + 60_000)
    expect(await publishNow('unavailable')).toBe(0)
    now.mockReturnValue(1_000_000 + 120_000)
    expect(await publishNow('unavailable')).toBe(1)
    // A real answer is never held back.
    expect(await publishNow('needs_you')).toBe(1)
    now.mockRestore()
  })
})
