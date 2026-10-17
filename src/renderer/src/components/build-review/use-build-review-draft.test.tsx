// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { BuildReviewDraft } from '../../../../shared/build-review-draft'
import { useBuildReviewDraft } from './use-build-review-draft'

afterEach(cleanup)

it('retains every setup choice through repeated conversation unmounts', () => {
  let saved: BuildReviewDraft | undefined
  const persist = vi.fn((draft: BuildReviewDraft) => {
    saved = structuredClone(draft)
  })
  const first = renderHook(() => useBuildReviewDraft('repo::/first', '', undefined, persist))
  act(() => {
    first.result.current.setWorktree('folder::/second')
    first.result.current.setObjective('Build accessible search')
    first.result.current.setReviewFocus('Keyboard navigation')
    first.result.current.setHubTaskId('btk_example')
    first.result.current.setBuilder({ agent: 'codex', model: 'build-model', effort: 'high' })
    first.result.current.setReviewers([
      { id: 0, choice: { agent: 'claude', model: 'review-model', effort: 'low' }, chosen: true },
      { id: 4, choice: { agent: 'codex', model: 'second-review', effort: 'medium' }, chosen: true }
    ])
    first.result.current.setMaxReviewRounds(5)
  })
  const expected = structuredClone(saved)
  first.unmount()
  for (let index = 0; index < 20; index++) {
    const restored = renderHook(() =>
      useBuildReviewDraft('repo::/first', 'fallback', saved, persist)
    )
    expect(saved).toEqual(expected)
    expect(restored.result.current.maxReviewRounds).toBe(5)
    expect(restored.result.current.reviewers).toEqual(expected?.reviewers)
    restored.unmount()
  }
})

it('retains invalid round input for correction instead of silently resetting it', () => {
  let saved: BuildReviewDraft | undefined
  const persist = (draft: BuildReviewDraft) => {
    saved = draft
  }
  const first = renderHook(() => useBuildReviewDraft('workspace', 'objective', undefined, persist))
  act(() => first.result.current.setMaxReviewRounds(0))
  first.unmount()
  const restored = renderHook(() => useBuildReviewDraft('workspace', '', saved, persist))
  expect(restored.result.current.maxReviewRounds).toBe(0)
})

it('keeps a locked workspace even when the saved draft names another one', () => {
  const saved: BuildReviewDraft = {
    worktree: 'repo::/other',
    objective: 'Build search',
    reviewFocus: '',
    hubTaskId: '',
    builder: { agent: 'codex' },
    reviewers: [{ id: 0, choice: { agent: 'claude' } }],
    maxReviewRounds: 2
  }
  const persist = vi.fn()
  const locked = renderHook(() => useBuildReviewDraft('repo::/tab', '', saved, persist, true))
  expect(locked.result.current.worktree).toBe('repo::/tab')
  // Everything else still comes back from the draft, and the draft now names the tab's workspace.
  expect(locked.result.current.objective).toBe('Build search')
  expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ worktree: 'repo::/tab' }))
  act(() => locked.result.current.setWorktree('repo::/other'))
  expect(locked.result.current.worktree).toBe('repo::/tab')
  locked.unmount()
  const picking = renderHook(() => useBuildReviewDraft('repo::/tab', '', saved, persist))
  expect(picking.result.current.worktree).toBe('repo::/other')
})
