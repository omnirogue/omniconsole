import { describe, expect, it } from 'vitest'
import {
  artifactSessionSleepLine,
  getEffectiveReviewWaitLiveMinutes,
  validArtifactReviewSleep
} from './artifact-review-sleep'

const SLEEP = {
  state: 'waiting',
  revision: 2,
  armedAt: 1,
  at: 1,
  provider: 'claude',
  accountHome: '/Users/me/.claude-accounts/a',
  model: 'opus',
  effort: 'xhigh',
  workspace: { kind: 'folder', path: '/Users/me/Work/x' }
}

describe('artifact review sleep record', () => {
  it('accepts a complete record and refuses broken ones', () => {
    expect(validArtifactReviewSleep(SLEEP)).toBe(true)
    expect(validArtifactReviewSleep({ ...SLEEP, state: 'dozing' })).toBe(false)
    expect(validArtifactReviewSleep({ ...SLEEP, provider: 'gemini' })).toBe(false)
    expect(validArtifactReviewSleep({ ...SLEEP, revision: 0 })).toBe(false)
    expect(validArtifactReviewSleep({ ...SLEEP, workspace: { kind: 'svn', path: '/x' } })).toBe(
      false
    )
    expect(validArtifactReviewSleep({ ...SLEEP, model: '' })).toBe(false)
    expect(validArtifactReviewSleep(null)).toBe(false)
  })

  it('reads the wait in whole minutes between one minute and a day, 60 by default', () => {
    expect(getEffectiveReviewWaitLiveMinutes(undefined)).toBe(60)
    expect(getEffectiveReviewWaitLiveMinutes('12')).toBe(60)
    expect(getEffectiveReviewWaitLiveMinutes(720)).toBe(720)
    expect(getEffectiveReviewWaitLiveMinutes(0)).toBe(1)
    expect(getEffectiveReviewWaitLiveMinutes(10_000)).toBe(1440)
    expect(getEffectiveReviewWaitLiveMinutes(29.6)).toBe(30)
  })

  it('tells the publishing agent what happens to it', () => {
    expect(artifactSessionSleepLine({ state: 'armed', liveMinutes: 60 })).toContain(
      'waits for a decision for 1 hour'
    )
    expect(artifactSessionSleepLine({ state: 'armed', liveMinutes: 720 })).toContain('12 hours')
    expect(artifactSessionSleepLine({ state: 'armed', liveMinutes: 45 })).toContain('45 minutes')
    expect(artifactSessionSleepLine({ state: 'kept' })).toContain('--keep-session')
    expect(
      artifactSessionSleepLine({ state: 'unavailable', reason: 'it is protected (pinned)' })
    ).toBe('This session will not sleep for the decision: it is protected (pinned)')
    expect(artifactSessionSleepLine(undefined)).toBeNull()
  })

  it('tells the agent of a review or study that the responses wake it, not a decision', () => {
    const armed = artifactSessionSleepLine({ state: 'armed', liveMinutes: 60 }, true)!
    expect(armed).toContain('waits for the responses for 1 hour')
    expect(armed).not.toContain('decision')
    expect(artifactSessionSleepLine({ state: 'kept' }, true)).toBe(
      'This session keeps running (--keep-session); the responses are queued to it once they are in.'
    )
    expect(artifactSessionSleepLine({ state: 'unavailable', reason: 'it is pinned' }, true)).toBe(
      'This session will not sleep for the responses: it is pinned'
    )
  })
})
