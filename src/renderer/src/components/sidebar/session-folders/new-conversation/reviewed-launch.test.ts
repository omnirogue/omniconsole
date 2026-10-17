/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import { useLaunchReview } from '@/components/launch-review/launch-review-store'
import {
  getSessionContext,
  launchSessionContextKey,
  setSessionContext
} from '@/lib/session-context-store'
import { consumeLaunchSessionContext } from '@/lib/launch-session-context'
import { reviewedLaunchStart } from './reviewed-launch'
import type { LaunchPick } from './resolve-launch-plan'

vi.mock('@/store', () => ({
  useAppStore: Object.assign(() => undefined, {
    getState: () => ({ settings: {} }),
    subscribe: () => () => undefined
  })
}))
vi.mock('@/lib/console-account-scope', () => ({ selectConsoleAccountScope: () => 'acct' }))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  getAgentDetectionTargetKeyForWorktree: () => 'local'
}))
vi.mock('@/lib/sidebar-sessions', () => ({ buildPaneSessions: () => [] }))
vi.mock('@/lib/project-launch', () => ({
  resolveLaunchProject: () => null,
  refreshOpenLaunchProjectDocuments: () => null
}))

const original = {
  id: 'instructions:original',
  kind: 'instructions' as const,
  title: 'First launch',
  content: 'Original instructions'
}
const later = { ...original, id: 'instructions:later', content: 'Next launch only' }
const key = launchSessionContextKey('workspace')

function openReview() {
  const start = vi.fn<(pick?: LaunchPick) => Promise<void>>().mockResolvedValue(undefined)
  reviewedLaunchStart({
    launch: { start },
    worktreeId: 'workspace',
    local: true,
    folder: undefined
  })({ agent: 'claude' })
  return { start, review: useLaunchReview.getState().request! }
}

afterEach(async () => {
  useLaunchReview.getState().close()
  await setSessionContext(key, [])
})

it('starts only the edited review and claims the original context, leaving later additions for next time', async () => {
  await setSessionContext(key, [original])
  const { start, review } = openReview()
  await setSessionContext(key, [original, later])
  const reviewed = { ...review.manifest, prompt: 'Reviewed task', attachments: [] }

  useLaunchReview.getState().close()
  review.onStart(reviewed, [original.id])

  const pick = start.mock.calls[0]?.[0]
  expect(pick?.opening?.prompt).toBe('Reviewed task')
  expect(pick?.sessionContext).toEqual([])
  expect(pick?.sessionContextRemoved).toEqual([original.id])
  expect(pick?.launchContextClaim).toEqual({ key, ids: [original.id] })
  expect(getSessionContext(key)).toEqual([original, later])
  // The launch hook consumes this snapshot only after its session starts successfully.
  consumeLaunchSessionContext(pick?.launchContextClaim)
  expect(getSessionContext(key)).toEqual([later])
})

it('cancelling the review leaves one-shot context available for another launch', async () => {
  await setSessionContext(key, [original])
  const { start } = openReview()

  useLaunchReview.getState().close()

  expect(start).not.toHaveBeenCalled()
  expect(getSessionContext(key)).toEqual([original])
})
