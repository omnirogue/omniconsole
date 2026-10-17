import { beforeEach, expect, it, vi } from 'vitest'
import {
  emptyLaunchManifest,
  type LaunchManifest
} from '../../../../../../../shared/launch-manifest'

const mocks = vi.hoisted(() => ({
  manifest: null as unknown as LaunchManifest,
  open: vi.fn(),
  launch: vi.fn(),
  toast: vi.fn()
}))
vi.mock('@/components/launch-review/launch-review-store', () => ({
  useLaunchReview: { getState: () => ({ open: mocks.open }) }
}))
vi.mock('../launch-context', () => ({
  launchManifestFor: () => mocks.manifest,
  launchRemovedFor: () => ['skill:unticked'],
  launchTargetFor: (worktreeId: string | null) =>
    worktreeId ? { kind: 'workspace', worktreeId } : { kind: 'work-root' }
}))
vi.mock('./launch-local-ollama', () => ({ launchLocalOllama: mocks.launch }))
vi.mock('sonner', () => ({ toast: { info: mocks.toast } }))

import { reviewedLocalOllamaLaunch } from './reviewed-local-ollama-launch'

beforeEach(() => {
  mocks.manifest = { ...emptyLaunchManifest(), folder: { id: 'f', name: 'Ads' } }
  mocks.open.mockReset().mockReturnValue(true)
  mocks.launch.mockReset().mockResolvedValue(true)
  mocks.toast.mockReset()
})

it('reviews what the launch attaches, then sends only the reviewed list', () => {
  const onLaunched = vi.fn()
  const onReviewChange = vi.fn()
  reviewedLocalOllamaLaunch({
    worktreeId: 'wt-1',
    folder: { id: 'f', name: 'Ads' },
    templateId: 'coordinator',
    tag: 'qwen',
    onLaunched,
    onReviewChange
  })
  expect(onReviewChange).toHaveBeenCalledWith(true)
  expect(mocks.launch).not.toHaveBeenCalled()
  const reviewed = { ...emptyLaunchManifest('go'), folder: { id: 'f', name: 'Ads' } }
  mocks.open.mock.calls[0]![0].onStart(reviewed, ['skill:dropped'])
  expect(mocks.launch).toHaveBeenCalledWith({
    templateId: 'coordinator',
    model: 'qwen',
    target: { kind: 'workspace', worktreeId: 'wt-1' },
    onLaunched,
    reviewed: { manifest: reviewed, removed: ['skill:unticked', 'skill:dropped'] }
  })
})

it('starts at once when nothing is attached', () => {
  mocks.manifest = emptyLaunchManifest()
  reviewedLocalOllamaLaunch({ worktreeId: null, folder: null, templateId: 'default', tag: 'qwen' })
  expect(mocks.open).not.toHaveBeenCalled()
  expect(mocks.launch).toHaveBeenCalledWith(
    expect.objectContaining({ target: { kind: 'work-root' }, model: 'qwen' })
  )
})

it('says so when another launch is waiting for review', () => {
  mocks.open.mockReturnValue(false)
  reviewedLocalOllamaLaunch({ worktreeId: null, folder: null, templateId: 'default', tag: 'qwen' })
  expect(mocks.toast).toHaveBeenCalled()
  expect(mocks.launch).not.toHaveBeenCalled()
})
