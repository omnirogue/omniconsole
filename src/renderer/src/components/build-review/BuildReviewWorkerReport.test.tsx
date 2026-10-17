// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BuildReviewWorkerReport } from './BuildReviewWorkerReport'

const mocks = vi.hoisted(() => ({ open: vi.fn() }))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, args?: Record<string, unknown>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(args?.[key] ?? ''))
}))
vi.mock('@/components/sidebar/CommentMarkdown', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>
}))
vi.mock('./open-worker-report', () => ({
  canOpenWorkerReport: (path: string | null) => Boolean(path),
  openWorkerReport: mocks.open
}))

afterEach(() => {
  cleanup()
  mocks.open.mockReset()
})

const report = {
  subject: 'Review: 1 MAJOR',
  body: 'One MAJOR remains.\n\nVERDICT: REQUEST_CHANGES',
  outcome: 'succeeded' as const,
  filesModified: [],
  reportPath: '/tmp/scratchpad/REVIEW.md',
  reportedAt: '2026-09-21T12:00:00Z'
}

describe('BuildReviewWorkerReport', () => {
  it('opens the full report the reviewer wrote', async () => {
    mocks.open.mockResolvedValue(undefined)
    render(<BuildReviewWorkerReport report={report} role="reviewer" worktreeId="repo::/wt" />)
    fireEvent.click(screen.getByRole('button', { name: 'Open full report' }))
    await vi.waitFor(() =>
      expect(mocks.open).toHaveBeenCalledWith('/tmp/scratchpad/REVIEW.md', 'repo::/wt')
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says so in words when the report cannot be opened, instead of doing nothing', async () => {
    mocks.open.mockRejectedValue(new Error('ENOENT'))
    render(<BuildReviewWorkerReport report={report} role="reviewer" worktreeId="repo::/wt" />)
    fireEvent.click(screen.getByRole('button', { name: 'Open full report' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The report at /tmp/scratchpad/REVIEW.md could not be opened.'
    )
  })
})
