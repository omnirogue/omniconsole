import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ArtifactReviewStatus } from '../shared/artifact-review'
import {
  ARTIFACT_REVIEW_POLL_INTERVAL_MS,
  artifactMutationRequestTarget,
  artifactReviewWaitStatus,
  artifactStatusRequestTarget,
  isSshArtifactCaller,
  parseArtifactStatusInvocation,
  pollArtifactReviewStatus
} from './artifact-review-status'

function flags(entries: [string, string | boolean][]): Map<string, string | boolean> {
  return new Map(entries)
}

describe('parseArtifactStatusInvocation', () => {
  it('defaults to a single read', () => {
    expect(parseArtifactStatusInvocation(flags([['file', 'plan.html']]))).toEqual({
      target: 'plan.html',
      waitSeconds: 0
    })
  })

  it('accepts every spelling of --wait and caps it at 600 seconds', () => {
    const expected = { target: 'plan.html', waitSeconds: 60 }
    expect(
      parseArtifactStatusInvocation(
        flags([
          ['file', 'plan.html'],
          ['wait', '60']
        ])
      )
    ).toEqual(expected)
    expect(
      parseArtifactStatusInvocation(
        flags([
          ['file', 'plan.html'],
          ['wait', true],
          ['wait-seconds', '60']
        ])
      )
    ).toEqual(expected)
    // `status --wait 60 plan.html` puts the seconds in the first positional.
    expect(
      parseArtifactStatusInvocation(
        flags([
          ['file', '60'],
          ['wait', true],
          ['wait-seconds', 'plan.html']
        ])
      )
    ).toEqual(expected)
    expect(
      parseArtifactStatusInvocation(
        flags([
          ['file', 'plan.html'],
          ['wait', '9000']
        ])
      )
    ).toEqual({ target: 'plan.html', waitSeconds: 600 })
  })

  it('rejects a missing target, bare --wait, bad seconds, and stray arguments', () => {
    expect(() => parseArtifactStatusInvocation(flags([]))).toThrow(/Missing required file/)
    expect(() =>
      parseArtifactStatusInvocation(
        flags([
          ['file', 'plan.html'],
          ['wait', true]
        ])
      )
    ).toThrow(/--wait needs a number of seconds/)
    expect(() =>
      parseArtifactStatusInvocation(
        flags([
          ['file', 'plan.html'],
          ['wait', '-5']
        ])
      )
    ).toThrow(/whole number of seconds/)
    expect(() =>
      parseArtifactStatusInvocation(
        flags([
          ['file', 'plan.html'],
          ['wait-seconds', '60']
        ])
      )
    ).toThrow(/Unexpected argument: 60/)
  })
})

describe('artifactStatusRequestTarget', () => {
  it('resolves a file path against the cwd and does not treat it as a slug', () => {
    expect(artifactStatusRequestTarget('./plans/launch.html', '/repo')).toEqual({
      sourceKey: resolve('/repo', 'plans/launch.html')
    })
  })

  it('also sends a slug-shaped argument as the artifact id', () => {
    expect(artifactStatusRequestTarget('aB3_x-9', '/repo')).toEqual({
      sourceKey: resolve('/repo', 'aB3_x-9'),
      slug: 'aB3_x-9'
    })
  })

  it('prefers the SSH relay source identity for the record lookup', () => {
    expect(
      artifactStatusRequestTarget('launch.html', '/host', '["ssh","t","/r/launch.html"]')
    ).toEqual({ sourceKey: '["ssh","t","/r/launch.html"]' })
  })
})

describe('artifactMutationRequestTarget', () => {
  it('keeps the file form locally and with SSH relay identity', () => {
    expect(artifactMutationRequestTarget('plan.html', '/repo', undefined, false)).toEqual({
      sourceKey: resolve('/repo', 'plan.html')
    })
    expect(
      artifactMutationRequestTarget('plan.html', '/r', '["ssh","t","/r/plan.html"]', true)
    ).toEqual({ sourceKey: '["ssh","t","/r/plan.html"]' })
  })

  it('never sends an unqualified local path for an SSH caller without relay identity', () => {
    expect(artifactMutationRequestTarget('plan-1', '/same/project', undefined, true)).toEqual({
      slug: 'plan-1'
    })
    expect(() =>
      artifactMutationRequestTarget('plan.html', '/same/project', undefined, true)
    ).toThrow(/Pass the page id or link instead/)
  })

  it('recognises the SSH caller only from the host passthrough stamp', () => {
    expect(isSshArtifactCaller({ ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND: 'ssh' })).toBe(true)
    expect(isSshArtifactCaller({})).toBe(false)
  })
})

describe('artifactReviewWaitStatus', () => {
  const pending = (artifact: Record<string, unknown>, top: Record<string, unknown> = {}) =>
    ({
      artifact: { slug: 'p', revision: 1, ...artifact },
      status: 'pending',
      ...top
    }) as never as ArtifactReviewStatus

  it('treats a closed or superseded page as final while its review still reads pending', () => {
    expect(artifactReviewWaitStatus(pending({}))).toBe('pending')
    expect(artifactReviewWaitStatus(pending({ lifecycle: 'no_action', closedAt: 't' }))).toBe(
      'closed:no_action'
    )
    expect(artifactReviewWaitStatus(pending({ supersededBy: 'next', supersededAt: 't' }))).toBe(
      'superseded'
    )
    expect(artifactReviewWaitStatus(pending({}, { lifecycle: 'done' }))).toBe('closed:done')
  })

  it('reads a review or study with its responses in as responses_in, and an older server as before', () => {
    const progress = (ready: boolean) => ({ progress: { id: 'p:1', revision: 1, ready } })
    expect(artifactReviewWaitStatus(pending({}, progress(true)))).toBe('responses_in')
    expect(artifactReviewWaitStatus(pending({}, progress(false)))).toBe('pending')
    expect(artifactReviewWaitStatus(pending({}, { progress: null }))).toBe('pending')
    expect(artifactReviewWaitStatus(pending({ lifecycle: 'done' }, progress(true)))).toBe(
      'closed:done'
    )
    expect(artifactReviewWaitStatus(pending({}, { ...progress(true), status: 'approved' }))).toBe(
      'approved'
    )
  })
})

describe('pollArtifactReviewStatus', () => {
  type Read = { status: string | null }
  const statusOf = (value: Read) => value.status

  function clock() {
    let time = 0
    return {
      now: () => time,
      sleep: vi.fn(async (ms: number) => {
        time += ms
      })
    }
  }

  it('reads once when not waiting, even if pending', async () => {
    const read = vi.fn<() => Promise<Read>>().mockResolvedValue({ status: 'pending' })
    const { now, sleep } = clock()
    await expect(
      pollArtifactReviewStatus(read, statusOf, { waitSeconds: 0, now, sleep })
    ).resolves.toEqual({ status: 'pending' })
    expect(read).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('stops --wait once a review or study has its responses in', async () => {
    const doc = (ready: boolean) =>
      ({
        artifact: { slug: 'p', revision: 1 },
        status: 'pending',
        progress: { id: 'p:1', revision: 1, ready }
      }) as never as ArtifactReviewStatus
    const read = vi
      .fn<() => Promise<ArtifactReviewStatus>>()
      .mockResolvedValueOnce(doc(false))
      .mockResolvedValueOnce(doc(true))
      .mockResolvedValue(doc(true))
    const { now, sleep } = clock()
    const result = await pollArtifactReviewStatus(read, artifactReviewWaitStatus, {
      waitSeconds: 600,
      now,
      sleep
    })
    expect(result.progress?.ready).toBe(true)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('stops as soon as the status leaves pending', async () => {
    const read = vi
      .fn<() => Promise<Read>>()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'changes_requested' })
    const { now, sleep } = clock()
    await expect(
      pollArtifactReviewStatus(read, statusOf, { waitSeconds: 600, now, sleep })
    ).resolves.toEqual({ status: 'changes_requested' })
    expect(read).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledWith(ARTIFACT_REVIEW_POLL_INTERVAL_MS)
  })

  it('does not wait when no review was requested', async () => {
    const read = vi.fn<() => Promise<Read>>().mockResolvedValue({ status: null })
    const { now, sleep } = clock()
    await pollArtifactReviewStatus(read, statusOf, { waitSeconds: 60, now, sleep })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('gives up at the deadline without sleeping past it', async () => {
    const read = vi.fn<() => Promise<Read>>().mockResolvedValue({ status: 'pending' })
    const { now, sleep } = clock()
    await expect(
      pollArtifactReviewStatus(read, statusOf, { waitSeconds: 7, now, sleep })
    ).resolves.toEqual({ status: 'pending' })
    // 0s, 3s, 6s, then the final read at the 7s deadline.
    expect(read).toHaveBeenCalledTimes(4)
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([3_000, 3_000, 1_000])
  })
})
