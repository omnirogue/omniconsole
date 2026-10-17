// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandoffDetail } from '../../../../shared/console-handoff-contract'
import { HandoffReviewPanel } from './HandoffReviewPanel'

const api = vi.hoisted(() => ({ review: vi.fn(), returnFile: vi.fn() }))
vi.mock('./handoff-client', () => ({ handoffApi: () => api }))
vi.mock('./HandoffFilePicker', () => ({ HandoffFilePicker: () => null }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const detail: HandoffDetail = {
  thread: {
    id: 'hth_proposal',
    board_task_id: null,
    author_employee_id: 'emp_sal',
    recipient_employee_id: 'emp_uma',
    title: 'Track this commitment?',
    state: 'open',
    action: 'decide',
    due_at: null,
    parent_thread_id: null,
    delivery_id: null,
    updated: '2026-09-19T19:00:00Z'
  },
  task_proposal: {
    company_id: 'co_omr',
    commitment_anchor: 'outcome:launch',
    proposed_commitment: 'Ship launch',
    next_check_at: '2026-09-21T16:00:00Z',
    triage_owner: 'emp_uma',
    decision: 'pending',
    creates_task: false,
    decision_id: 'dcn_proposal'
  },
  files: [],
  reviews: [],
  entries: []
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  api.review.mockResolvedValue({ ok: true, data: detail })
})
afterEach(cleanup)

describe('tracking proposal file reviews', () => {
  it('does not offer an empty file approval for a tracking decision', () => {
    const onChanged = vi.fn()
    render(<HandoffReviewPanel scope="test" detail={detail} onChanged={onChanged} />)
    expect(screen.queryByRole('button', { name: 'Approve reviewed versions' })).toBeNull()
    expect(api.review).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('allows an exact file review alongside the separate tracking decision', async () => {
    const withFile: HandoffDetail = {
      ...detail,
      files: [
        {
          id: 'hfv_one',
          path: 'proposal.md',
          name: 'proposal.md',
          sha256: 'a'.repeat(64),
          size: 12,
          version: 1,
          parent_version_id: null,
          current: true,
          available: true
        }
      ]
    }
    const onChanged = vi.fn()
    render(<HandoffReviewPanel scope="test" detail={withFile} onChanged={onChanged} />)
    fireEvent.change(screen.getByLabelText('Review or return note'), {
      target: { value: 'File reviewed.' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Approve reviewed versions' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(api.review).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'hth_proposal',
        decision: 'approve',
        versionIds: ['hfv_one'],
        note: 'File reviewed.'
      })
    )
  })
})
