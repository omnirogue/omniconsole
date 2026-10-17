// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { SessionProjectThread } from '@/lib/session-project-threads'

const mocks = vi.hoisted(() => ({ start: vi.fn(), file: vi.fn() }))
vi.mock('./use-project-folder-launch', () => ({
  useProjectFolderLaunch: () => ({ start: mocks.start })
}))
vi.mock('@/lib/pending-folder-launches', () => ({ fileLaunchInFolder: mocks.file }))

import { useProjectReviewLaunch } from './use-project-review-launch'

it('starts a Reviewer thread on the review, filed in the project', () => {
  const folder = { id: 'folder-1', name: 'Ads' }
  const { result } = renderHook(() => useProjectReviewLaunch(folder))
  const thread = { row: { session: { label: 'Fix checkout' } } } as SessionProjectThread
  result.current(thread, { label: '#12', url: 'https://github.com/o/r/pull/12' })
  const [pick, options] = mocks.start.mock.calls[0]!
  expect(pick.opening.prompt).toContain('Review #12 (https://github.com/o/r/pull/12)')
  expect(pick.opening.prompt).toContain('“Fix checkout”')
  expect(options.templateId).toBe('reviewer')
  options.onLaunched('tab-9')
  expect(mocks.file).toHaveBeenCalledWith('tab-9', 'folder-1')
})
