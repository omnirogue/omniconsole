import { describe, expect, it } from 'vitest'
import { buildWorkViews, type WorkViewsInput } from './backoffice-work-views'

function input(truncated: WorkViewsInput['truncated']): WorkViewsInput {
  return {
    employeeId: 'emp_sal',
    todo: { items: [], awaitingVerification: [], truncated: false },
    received: { open: [], history: [] },
    sent: [],
    truncated,
    followUps: [],
    humanJobs: [],
    messages: []
  }
}

describe('buildWorkViews paging gaps', () => {
  it('names each list that holds more than the pages the client read', () => {
    expect(buildWorkViews(input({ received: true, history: true, sent: true })).gaps).toEqual([
      'received-truncated',
      'history-truncated',
      'sent-truncated'
    ])
  })

  it('reports nothing when every list was read to its end', () => {
    expect(buildWorkViews(input({ received: false, history: false, sent: false })).gaps).toEqual([])
    expect(buildWorkViews(input(undefined)).gaps).toEqual([])
  })

  it('does not call an unavailable list truncated', () => {
    const views = buildWorkViews({
      ...input({ received: true, sent: true }),
      received: { open: null, history: [] },
      sent: null
    })
    expect(views.gaps).not.toContain('received-truncated')
    expect(views.gaps).not.toContain('sent-truncated')
  })
})
