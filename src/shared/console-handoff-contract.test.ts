import { describe, expect, it } from 'vitest'
import { handoffDetail, handoffQueue } from './console-handoff-contract'
import { consoleJiraIssueUrl, consoleJiraWorkRef } from './console-jira-work-contract'

describe('handoffs without a card', () => {
  it('accepts a thread whose board_task_id is null (hub 2026-09-14: person-to-person handoffs)', () => {
    const parsed = handoffQueue.safeParse({
      assignee: 'emp_uma',
      threads: [
        {
          id: 'hth_28bd24c083fd4b49aaac',
          board_task_id: null,
          author_employee_id: 'emp_sal_qa_test',
          recipient_employee_id: 'emp_uma',
          title: 'Live handoff test from Sal to Uma',
          state: 'open',
          action: null,
          due_at: null,
          parent_thread_id: null,
          delivery_id: null,
          updated: '2026-09-14T20:17:02Z',
          unread_entries: 1
        }
      ]
    })
    expect(parsed.success).toBe(true)
  })
})

describe('a review read back from the hub', () => {
  // The hub's review row carries `entry_id`, never a note: the words are the reply entry's body
  // (live thread hth_00cb490142da4ad1b792, 2026-09-18 — the sender's agent was told "no note").
  const thread = {
    id: 'hth_00cb490142da4ad1b792',
    board_task_id: 'btk_634535786bbe4c7f9ec6',
    author_employee_id: 'emp_sal',
    recipient_employee_id: 'emp_sal_qa_test',
    title: 'Review: draft one',
    state: 'open',
    action: 'review',
    due_at: null,
    parent_thread_id: null,
    delivery_id: null,
    updated: '2026-09-18T21:25:04Z'
  }
  const entry = (id: string, kind: string, body: string) => ({ id, kind, body, created: '' })
  const review = (id: string, entryId?: string) => ({
    id,
    decision: 'request_changes',
    version_ids: [],
    current: true,
    ...(entryId ? { entry_id: entryId } : {})
  })

  it('carries the reviewer’s words from the reply entry the review points at', () => {
    const detail = handoffDetail.parse({
      thread,
      files: [],
      entries: [
        entry('hte_open', 'handoff', 'Please review this work.'),
        entry('hte_4b181eb7a6ec46d9ae19', 'reply', 'Say DRAFT TWO instead of DRAFT ONE.')
      ],
      reviews: [review('hrv_b58d064dba014e6d81ca', 'hte_4b181eb7a6ec46d9ae19')]
    })
    expect(detail.reviews[0]?.note).toBe('Say DRAFT TWO instead of DRAFT ONE.')
  })

  it('leaves a review without a readable entry as the hub sent it', () => {
    const detail = handoffDetail.parse({
      thread,
      files: [],
      entries: [entry('hte_open', 'handoff', 'Please review this work.')],
      reviews: [review('hrv_one', 'hte_gone'), review('hrv_two')]
    })
    expect(detail.reviews.map((row) => row.note)).toEqual([undefined, undefined])
  })
})

describe('Jira references on native work', () => {
  const ref = {
    provider: 'jira',
    cloud_id: 'bb6f9191-a21a-4857-b965-32de82dce68b',
    issue_id: '10123',
    issue_key: 'OMR-123',
    project_key: 'OMR'
  }
  it('rejects a mismatched project and keeps connection IDs distinct from cloud IDs', () => {
    expect(consoleJiraWorkRef.safeParse({ ...ref, project_key: 'APU' }).success).toBe(false)
    expect(
      consoleJiraWorkRef.safeParse({ ...ref, cloud_id: 'local-jira-connection' }).success
    ).toBe(false)
  })
  it('does not open an unfamiliar tenant on the configured company site', () => {
    const parsed = consoleJiraWorkRef.parse(ref)
    expect(consoleJiraIssueUrl(parsed)).toBe('https://example-team.atlassian.net/browse/OMR-123')
    expect(
      consoleJiraIssueUrl({ ...parsed, cloud_id: 'a17d330c-85ca-4aa2-8133-0be390a8d029' })
    ).toBeNull()
  })
  it('keeps Jira tracking and review words through the native detail transform', () => {
    const proposal = {
      company_id: 'co_omr',
      commitment_anchor: 'outcome:launch',
      proposed_commitment: 'Ship launch',
      next_check_at: '2026-09-21T16:00:00Z',
      triage_owner: 'emp_sal',
      decision: 'pending',
      creates_task: false,
      decision_id: 'dcn_proposal'
    }
    const parsed = handoffDetail.parse({
      thread: {
        id: 'hth_one',
        board_task_id: null,
        task_ref: ref,
        author_employee_id: 'emp_uma',
        recipient_employee_id: 'emp_sal',
        title: 'Ship launch',
        state: 'open',
        action: 'review',
        due_at: null,
        parent_thread_id: null,
        delivery_id: null,
        updated: ''
      },
      task_proposal: proposal,
      files: [],
      entries: [{ id: 'hte_one', kind: 'reply', body: 'Please revise.', created: '' }],
      reviews: [
        {
          id: 'hrv_one',
          entry_id: 'hte_one',
          decision: 'request_changes',
          version_ids: [],
          current: true
        }
      ]
    })
    expect(parsed.thread.task_ref).toEqual(ref)
    expect(parsed.task_proposal).toEqual(proposal)
    expect(parsed.reviews[0]?.note).toBe('Please revise.')
  })
})
