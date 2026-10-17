import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ProfilePaths from '../omni-profiles/profile-storage-paths'
import { paneKeyTeardownListeners } from '../ipc/pty/pane/key-state'
import {
  getArtifactShareRecord,
  saveArtifactShareRecord,
  type ArtifactShareRecord
} from '../artifacts/artifact-share-record-store'
import { watchReviewWaitTeardown } from './review-wait-teardown'

const scope = {
  cloudUserId: 'user',
  cloudProfileId: 'cloud-profile',
  cloudOrganizationId: 'org',
  apiOrigin: 'https://omnios.example'
}
const state = vi.hoisted(() => ({ path: '' }))
vi.mock('../omni-profiles/profile-storage-paths', async (original) => ({
  ...(await original<typeof ProfilePaths>()),
  getProfileUserDataPath: () => state.path
}))
vi.mock('../artifacts/artifact-share-scope', () => ({
  activeArtifactShareScope: () => ({ profileId: 'profile', scope })
}))

function record(
  slug: string,
  paneKey: string,
  sleepState: 'waiting' | 'awake'
): ArtifactShareRecord {
  return {
    ...scope,
    slug,
    editToken: 'kept-private',
    shareUrl: `${scope.apiOrigin}/${slug}`,
    sourceReview: {
      ledgerId: 'als_0123456789abcdef01234567',
      nativeSessionId: 'conversation',
      paneKey,
      worktreeId: 'repo::/w',
      account: 'account',
      revision: 1
    },
    sleep: { state: sleepState, revision: 1, armedAt: 100, at: 100, provider: 'claude' }
  }
}

describe('review wait on terminal teardown', () => {
  let stop: () => void = () => {}

  beforeEach(() => {
    state.path = mkdtempSync(join(tmpdir(), 'review-teardown-'))
  })

  afterEach(() => {
    stop()
    rmSync(state.path, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const sleepOf = (key: string) => getArtifactShareRecord('profile', state.path, key, scope)?.sleep

  it('marks only the ended pane’s waiting reviews asleep, by pane key alone', () => {
    saveArtifactShareRecord(
      'profile',
      state.path,
      '/w/plan.md',
      record('plan', 'tab-1:1', 'waiting')
    )
    saveArtifactShareRecord('profile', state.path, '/w/done.md', record('done', 'tab-1:1', 'awake'))
    saveArtifactShareRecord(
      'profile',
      state.path,
      '/w/other.md',
      record('other', 'tab-2:1', 'waiting')
    )
    stop = watchReviewWaitTeardown(
      () => scope.apiOrigin,
      state.path,
      () => 500
    )

    for (const listener of paneKeyTeardownListeners) {
      listener('tab-1:1')
    }

    expect(sleepOf('/w/plan.md')).toMatchObject({ state: 'asleep', sleptAt: 500, at: 500 })
    expect(sleepOf('/w/done.md')?.state).toBe('awake')
    expect(sleepOf('/w/other.md')?.state).toBe('waiting')
  })

  it('never lets a failed write break the teardown, and stops listening when asked', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = paneKeyTeardownListeners.size
    stop = watchReviewWaitTeardown(() => {
      throw new Error('origin unreadable')
    }, state.path)
    expect(paneKeyTeardownListeners.size).toBe(before + 1)

    for (const listener of paneKeyTeardownListeners) {
      expect(() => listener('tab-1:1')).not.toThrow()
    }
    expect(warn).toHaveBeenCalledTimes(1)
    stop()
    expect(paneKeyTeardownListeners.size).toBe(before)
  })
})
