import { describe, expect, it } from 'vitest'
import { normalizeTodoPayload } from './backoffice-todo-payload'

const BASE = 'https://omnios.example'

describe('normalizeTodoPayload', () => {
  it('keeps the attention fields and drops the executable half of the prepared action', () => {
    const result = normalizeTodoPayload(
      {
        employee_id: 'emp_sal',
        generated_at: '2026-09-11T10:00:00Z',
        items: [
          {
            task_id: 'btk_1',
            title: 'Decide the rollout',
            kind: 'decision',
            decision_id: 'dec_1',
            qa_policy_id: null,
            replies_waiting_count: 2,
            owner_employee_id: 'emp_sal',
            primary_action: {
              label: 'Approve recommendation: A',
              method: 'POST',
              path: '/api/decisions/dec_1/decide',
              body: { action: 'approve' },
              handoff_decision: { thread_id: 'hth_abc', options: [] }
            }
          }
        ],
        counts: { total: 1, replies_waiting: 2 }
      },
      BASE
    )
    expect(result.items[0]).toMatchObject({
      kind: 'decision',
      decision_id: 'dec_1',
      qa_policy_id: null,
      replies_waiting_count: 2,
      owner_employee_id: 'emp_sal'
    })
    expect(result.items[0]?.primary_action).toEqual({
      label: 'Approve recommendation: A',
      method: 'POST',
      external: false,
      handoff_thread_id: 'hth_abc',
      handoff_options: null,
      handoff_recommended: null
    })
    expect(JSON.stringify(result)).not.toContain('/api/decisions')
    expect(result.truncated).toBe(false)
  })

  it("keeps an agent question's options and recommendation so Work can answer it", () => {
    const item = (options: unknown, recommended: unknown) =>
      normalizeTodoPayload(
        {
          items: [
            {
              task_id: 'dcn_1',
              title: 'Which port?',
              kind: 'decision',
              decision_id: 'dcn_1',
              primary_action: {
                label: 'Approve recommendation: 8080',
                handoff_decision: { thread_id: 'hth_abc', options, recommended }
              }
            }
          ]
        },
        BASE
      ).items[0]?.primary_action
    const options = [
      { label: '8080', value: '8080' },
      { label: 'Keep 3000', value: 'keep' }
    ]
    expect(item(options, { value: 'keep', reason: 'Fewer changes' })).toMatchObject({
      handoff_options: options,
      handoff_recommended: 'keep'
    })
    // A recommendation that is not one of the options recommends nothing.
    expect(item(options, { value: 'other' })?.handoff_recommended).toBeNull()
    // One malformed option drops them all: a partial list would hide a choice.
    expect(item([...options, { label: '', value: 'x' }], null)?.handoff_options).toBeNull()
  })

  it('flags a capped first page and a server that sends no verification feed', () => {
    const result = normalizeTodoPayload(
      { items: [{ task_id: 'btk_1', title: 'One' }], counts: { total: 250 } },
      BASE
    )
    expect(result.truncated).toBe(true)
    expect(result.awaitingVerification).toBeNull()
  })

  it('reads the next page position and judges truncation by it when the server pages', () => {
    const paged = normalizeTodoPayload(
      { items: [{ task_id: 'btk_1', title: 'One' }], counts: { total: 250 }, next_cursor: 'c_2' },
      BASE
    )
    expect(paged).toMatchObject({ nextCursor: 'c_2', truncated: true })
    const last = normalizeTodoPayload(
      { items: [{ task_id: 'btk_1', title: 'One' }], counts: { total: 250 }, next_cursor: null },
      BASE
    )
    // Why: a paging server that answers no next page is complete, whatever its total says.
    expect(last).toMatchObject({ nextCursor: null, truncated: false })
  })

  it('refuses a next page position that could carry query syntax', () => {
    const result = normalizeTodoPayload({ items: [], next_cursor: 'c&view=sent' }, BASE)
    expect(result).toMatchObject({ nextCursor: null, truncated: false })
  })

  it('reads awaiting_verification when the server sends it', () => {
    const result = normalizeTodoPayload(
      { items: [], awaiting_verification: [{ task_id: 'btk_9', title: 'Delivered' }, {}] },
      BASE
    )
    expect(result.awaitingVerification?.map((item) => item.task_id)).toEqual(['btk_9'])
  })

  it('refuses a malformed thread id and negative or fractional counts', () => {
    const result = normalizeTodoPayload(
      {
        items: [
          {
            task_id: 'btk_2',
            title: 'Two',
            replies_waiting_count: -1,
            primary_action: { label: 'Open', handoff_decision: { thread_id: '../../x' } }
          }
        ],
        counts: { total: 1.5, blocked: -2 }
      },
      BASE
    )
    expect(result.items[0]?.replies_waiting_count).toBeNull()
    expect(result.items[0]?.primary_action?.handoff_thread_id).toBeNull()
    expect(result.counts).toEqual({
      total: null,
      blocked: null,
      replies_waiting: null,
      awaiting_verification: null
    })
  })

  it('lists a card once when the hub answers one row per role', () => {
    const row = (role: string) => ({
      task_id: 'btk_dup00001',
      title: 'Triage: duplicated card',
      role,
      kind: role,
      status: 'awaiting_approval'
    })
    const result = normalizeTodoPayload(
      { ok: true, employee_id: 'emp_uma', items: [row('approval'), row('owner')] },
      BASE
    )
    expect(result.items.map((item) => item.task_id)).toEqual(['btk_dup00001'])
    expect(result.items[0]?.role).toBe('approval')
  })
})
