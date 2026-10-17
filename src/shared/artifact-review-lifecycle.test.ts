import { describe, expect, it } from 'vitest'
import {
  artifactLifecycleRequestSchema,
  artifactLifecycleSnapshot,
  type ArtifactReviewStatus
} from './artifact-review'

const parse = (body: unknown) => artifactLifecycleRequestSchema.safeParse(body).success

describe('artifactLifecycleRequestSchema', () => {
  it('accepts each action with its own fields', () => {
    expect(
      parse({
        action: 'close',
        revision: 3,
        lifecycle: 'done',
        note: 'Shipped',
        ref: 'https://github.com/o/r/pull/1',
        expect: 'open'
      })
    ).toBe(true)
    expect(parse({ action: 'close', revision: 0, lifecycle: 'no_action' })).toBe(true)
    expect(
      parse({ action: 'supersede', revision: 1, by: 'next-page', expect: 'unsuperseded' })
    ).toBe(true)
    expect(
      parse({ action: 'reopen', revision: 1, closedAt: '2026-09-30T10:00:00.123456+00:00' })
    ).toBe(true)
    expect(
      parse({
        action: 'unsupersede',
        revision: 1,
        by: 'next-page',
        supersededAt: '2026-09-30T10:00:00Z'
      })
    ).toBe(true)
  })

  it('refuses a missing fence, a wrong-action field, and bad links', () => {
    expect(parse({ action: 'close', lifecycle: 'done' })).toBe(false)
    expect(parse({ action: 'close', revision: 1.5, lifecycle: 'done' })).toBe(false)
    expect(parse({ action: 'close', revision: 1, lifecycle: 'withdrawn' })).toBe(false)
    expect(
      parse({ action: 'close', revision: 1, lifecycle: 'no_action', ref: 'https://x.test/a' })
    ).toBe(false)
    expect(parse({ action: 'close', revision: 1, lifecycle: 'done', ref: 'http://x.test/a' })).toBe(
      false
    )
    expect(parse({ action: 'close', revision: 1, lifecycle: 'done', expect: 'unsuperseded' })).toBe(
      false
    )
    expect(parse({ action: 'supersede', revision: 1, by: '../admin' })).toBe(false)
    expect(parse({ action: 'supersede', revision: 1, by: 'a', note: 'x' })).toBe(false)
    expect(parse({ action: 'reopen', revision: 1 })).toBe(false)
    expect(parse({ action: 'unsupersede', revision: 1, by: 'a' })).toBe(false)
    expect(parse({ action: 'withdraw', revision: 1 })).toBe(false)
  })
})

describe('artifactLifecycleSnapshot', () => {
  const base = {
    artifact: { slug: 'a', revision: 4 },
    shareUrl: 'https://console.example.com/a/a',
    status: 'approved',
    latest: null,
    decisions: [],
    viewer: { signedIn: true, isOwner: true, canDecide: false }
  } as unknown as ArtifactReviewStatus

  it('reads the artifact metadata, then top-level fields, and nulls an older server', () => {
    expect(artifactLifecycleSnapshot(base)).toEqual({
      revision: 4,
      lifecycle: null,
      closedAt: null,
      closedRef: null,
      supersededBy: null,
      supersededAt: null
    })
    expect(
      artifactLifecycleSnapshot({
        ...base,
        artifact: { ...base.artifact, lifecycle: 'done', closedAt: 't1' },
        supersededBy: 'b',
        supersededAt: 't2'
      })
    ).toMatchObject({ lifecycle: 'done', closedAt: 't1', supersededBy: 'b', supersededAt: 't2' })
  })
})
