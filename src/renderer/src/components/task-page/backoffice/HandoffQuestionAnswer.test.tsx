// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorkflowClient from '@/lib/console-workflow-client'
import type { BackofficeTodoItem } from '../../../../../shared/backoffice-work-types'
import { buildWorkViews } from '../../../../../shared/backoffice-work-views'
import { HandoffQuestionAnswer, isAnswerableHandoffQuestion } from './HandoffQuestionAnswer'
import {
  ANSWERED_QUESTION_HIDE_MS,
  useAnsweredHandoffQuestions,
  withoutAnsweredQuestions
} from './handoff-question-answered'

const decide = vi.fn()
const markRead = vi.hoisted(() => vi.fn())
const invalidate = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: toastError } }))
vi.mock('./backoffice-work-store', () => ({ invalidateBackofficeWork: invalidate }))
vi.mock('@/components/handoffs/handoff-client', () => ({ handoffApi: () => ({ markRead }) }))
vi.mock('@/lib/console-workflow-client', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkflowClient>()
  return { ...actual, consoleWorkflowApi: () => ({ decideHandoffQuestion: decide }) }
})

const QUESTION: BackofficeTodoItem = {
  task_id: 'dcn_0123abcd',
  title: 'Which port should the preview use?',
  kind: 'decision',
  decision_id: 'dcn_0123abcd',
  primary_action: {
    label: 'Approve recommendation: Keep 3000',
    handoff_thread_id: 'hth_abc',
    handoff_options: [
      { label: '8080', value: '8080' },
      { label: 'Keep 3000', value: 'keep' }
    ],
    handoff_recommended: 'keep'
  }
}

beforeEach(() => {
  markRead.mockResolvedValue({ ok: true, data: {} })
})

afterEach(() => {
  cleanup()
  decide.mockReset()
  markRead.mockReset()
  invalidate.mockReset()
  toastError.mockReset()
  useAnsweredHandoffQuestions.setState({ ids: new Map() })
})

describe('HandoffQuestionAnswer', () => {
  it('answers with the chosen option and leaves Needs you', async () => {
    decide.mockResolvedValueOnce({
      ok: true,
      data: { id: 'dcn_0123abcd', status: 'done_verified' }
    })
    render(<HandoffQuestionAnswer item={QUESTION} />)
    fireEvent.click(screen.getByRole('button', { name: '8080' }))
    await waitFor(() => expect(invalidate).toHaveBeenCalledOnce())
    expect(screen.getByText('Answered')).toBeTruthy()
    expect(decide).toHaveBeenCalledExactlyOnceWith({
      decisionId: 'dcn_0123abcd',
      action: 'reply',
      value: '8080'
    })
    expect(markRead).toHaveBeenCalledExactlyOnceWith({ threadId: 'hth_abc' })
    expect(markRead.mock.invocationCallOrder[0]).toBeLessThan(
      invalidate.mock.invocationCallOrder[0]!
    )
  })

  it('still leaves Needs you when reading the thread fails', async () => {
    decide.mockResolvedValueOnce({ ok: true, data: { id: 'dcn_0123abcd', status: 'denied' } })
    markRead.mockRejectedValueOnce(new Error('offline'))
    render(<HandoffQuestionAnswer item={QUESTION} />)
    fireEvent.click(screen.getByRole('button', { name: 'Not needed' }))
    await waitFor(() => expect(invalidate).toHaveBeenCalledOnce())
    expect(screen.getByText('Answered')).toBeTruthy()
    expect(useAnsweredHandoffQuestions.getState().ids.has('dcn_0123abcd')).toBe(true)
    expect(toastError).not.toHaveBeenCalled()
  })

  it('says Not needed with a deny, and counts an answer made elsewhere as answered', async () => {
    decide.mockResolvedValueOnce({
      ok: false,
      error: { code: 'already_decided', message: 'This ask was already decided', status: 409 }
    })
    render(<HandoffQuestionAnswer item={QUESTION} />)
    fireEvent.click(screen.getByRole('button', { name: 'Not needed' }))
    await waitFor(() => expect(screen.getByText('Answered')).toBeTruthy())
    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({ decisionId: 'dcn_0123abcd', action: 'deny' })
    )
    expect(toastError).not.toHaveBeenCalled()
  })

  it('keeps the question and says why when the hub refuses', async () => {
    decide.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unauthorized', message: 'Sign in again', status: 401 }
    })
    render(<HandoffQuestionAnswer item={QUESTION} />)
    fireEvent.click(screen.getByRole('button', { name: 'Keep 3000' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Sign in again'))
    expect(screen.getByRole('button', { name: 'Keep 3000' })).toBeTruthy()
    expect(invalidate).not.toHaveBeenCalled()
    expect(markRead).not.toHaveBeenCalled()
  })

  it('offers itself only for a question that names its decision and options', () => {
    expect(isAnswerableHandoffQuestion(QUESTION)).toBe(true)
    expect(isAnswerableHandoffQuestion({ ...QUESTION, decision_id: null })).toBe(false)
    expect(
      isAnswerableHandoffQuestion({
        ...QUESTION,
        primary_action: { ...QUESTION.primary_action, handoff_options: null }
      })
    ).toBe(false)
  })

  it('hides an answered question and its thread from Work until a fresh read could drop them', async () => {
    decide.mockResolvedValueOnce({ ok: true, data: { id: 'dcn_0123abcd', status: 'denied' } })
    render(<HandoffQuestionAnswer item={QUESTION} />)
    fireEvent.click(screen.getByRole('button', { name: 'Not needed' }))
    await waitFor(() => expect(screen.getByText('Answered')).toBeTruthy())
    const views = buildWorkViews({
      employeeId: 'emp_sal',
      todo: {
        items: [
          { ...QUESTION, who: 'emp_sal' },
          {
            task_id: 'btk_1',
            title: 'Other',
            kind: 'decision',
            who: 'emp_sal',
            primary_action: { handoff_thread_id: 'hth_other' }
          }
        ],
        awaitingVerification: [],
        truncated: false
      },
      received: {
        open: [
          {
            id: 'hth_abc',
            board_task_id: 'btk_aa',
            author_employee_id: 'emp_gamma',
            recipient_employee_id: 'emp_sal',
            title: 'Port',
            state: 'open',
            action: 'decide',
            due_at: null,
            parent_thread_id: null,
            delivery_id: null,
            updated: '2026-10-05T09:00:00Z',
            files: [],
            reviews: []
          }
        ],
        history: []
      },
      sent: [],
      followUps: [],
      humanJobs: [],
      messages: []
    })
    expect(views.needsYou).toHaveLength(2)
    const ids = useAnsweredHandoffQuestions.getState().ids
    const at = ids.get('dcn_0123abcd')!
    // A cached read right after the answer still lists it with its thread; Work shows neither.
    const hidden = withoutAnsweredQuestions(views, ids, at + 1_000)
    expect(hidden.needsYou.map((row) => row.todo?.task_id)).toEqual(['btk_1'])
    expect(hidden.all.some((row) => row.thread?.id === 'hth_abc')).toBe(false)
    expect(hidden.counts).toMatchObject({ needsYou: 1, decisions: 1 })
    // Long after, the next read is trusted again.
    expect(
      withoutAnsweredQuestions(views, ids, at + ANSWERED_QUESTION_HIDE_MS).needsYou
    ).toHaveLength(2)
  })

  it('treats only an already-decided 409 as answered', async () => {
    decide.mockResolvedValueOnce({
      ok: false,
      error: { code: 'routine_conflict', message: 'The routine moved on', status: 409 }
    })
    render(<HandoffQuestionAnswer item={QUESTION} />)
    fireEvent.click(screen.getByRole('button', { name: 'Keep 3000' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('The routine moved on'))
    expect(screen.getByRole('button', { name: 'Keep 3000' })).toBeTruthy()
  })

  it("keeps one question's answered state off the next one shown in its place", async () => {
    let finish: (value: unknown) => void = () => {}
    decide.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
    const other: BackofficeTodoItem = {
      ...QUESTION,
      task_id: 'dcn_9999ffff',
      decision_id: 'dcn_9999ffff'
    }
    const { rerender } = render(
      <HandoffQuestionAnswer key={QUESTION.decision_id} item={QUESTION} />
    )
    fireEvent.click(screen.getByRole('button', { name: '8080' }))
    rerender(<HandoffQuestionAnswer key={other.decision_id} item={other} />)
    finish({ ok: true, data: { id: 'dcn_0123abcd', status: 'done_verified' } })
    await waitFor(() => expect(invalidate).toHaveBeenCalledOnce())
    expect(screen.queryByText('Answered')).toBeNull()
    expect(screen.getByRole('button', { name: '8080' })).toBeTruthy()
    expect(useAnsweredHandoffQuestions.getState().ids.has('dcn_0123abcd')).toBe(true)
    expect(useAnsweredHandoffQuestions.getState().ids.has('dcn_9999ffff')).toBe(false)
  })
})
