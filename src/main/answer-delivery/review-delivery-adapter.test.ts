import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaimableDelivery } from '../work-delivery/work-delivery-kind'

const mocks = vi.hoisted(() => ({
  pass: null as unknown,
  records: [] as [string, unknown][]
}))
vi.mock('../artifacts/artifact-review-pass-context', () => ({
  reviewPassContext: () => mocks.pass
}))
vi.mock('../artifacts/artifact-share-record-store', () => ({
  listArtifactShareRecords: () => mocks.records
}))

import { reviewDeliveryAdapter, type ReviewDeliveryOptions } from './review-delivery-adapter'

const SLUG = '1a1463cfb969aad9b'
const ASKING = '183553fc-03b2-4bfe-adea-b2962bc2d3d8'
const PUBLISHER = '7dbd0529-2c5d-4b9a-9f78-50cdc37fb6bf'

const delivery = (overrides: Partial<ClaimableDelivery> = {}): ClaimableDelivery => ({
  key: `review:${SLUG}:758`,
  workItem: `review:${SLUG}`,
  kind: 'review',
  text: `[OmniOS decision] Sal approved “Launch plan” (https://app.omnisi.ai/a/${SLUG}).`,
  context: { slug: SLUG, decisionId: 758 },
  state: 'pending',
  step: '',
  heldReason: null,
  attempts: 0,
  createdAt: '2026-10-16T23:29:00Z',
  eventAt: '2026-10-16T23:29:00Z',
  respawnedRef: null,
  owner: null,
  ...overrides
})

const runtime = {
  requestSessionFolders: async () => null,
  listPromptQueues: () => ({}),
  settlePromptQueueEntry: vi.fn(),
  getStatus: () => ({ desktopWindowStatus: 'available' })
} as never

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'review-adapter-'))
  mocks.pass = null
  mocks.records = []
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function sidecar(notifyState: Record<string, unknown>, notify = `mac-studio:${ASKING}`) {
  mkdirSync(join(dir, 'choices', '2026-10-16'), { recursive: true })
  writeFileSync(
    join(dir, 'choices', '2026-10-16', '191227-plan.json'),
    JSON.stringify({
      slug: SLUG,
      cwd: '/Users/maintainer/omni-ide-worktrees/feat-1',
      notify,
      notifyState
    })
  )
}

function adapter(options: Partial<ReviewDeliveryOptions> = {}) {
  return reviewDeliveryAdapter({} as never, dir, {
    paths: { choicesDir: join(dir, 'choices') },
    localHost: 'mac-studio',
    locate: async () => [],
    findPublisher: async () => null,
    ...options
  })
}

describe('reviewDeliveryAdapter: unbound pages', () => {
  it('opts in to transcript confirmation and still claims visibly (no claimOnlyWhenHeld)', () => {
    const review = adapter()
    expect(review.confirmByTranscript).toBe(true)
    expect(review.claimOnlyWhenHeld).toBeUndefined()
  })

  it('reaches the asking session its sidecar names, in the folder the sidecar recorded', async () => {
    sidecar({ state: 'watching' })
    const target = await adapter({ locate: async () => [join(dir, `${ASKING}.jsonl`)] }).resolve(
      delivery(),
      runtime
    )
    expect(target).toEqual({
      ref: `claude:${ASKING}@local`,
      folder: '/Users/maintainer/omni-ide-worktrees/feat-1',
      transcript: 'present'
    })
  })

  it('marks the asking session gone on this computer when its transcript is missing', async () => {
    sidecar({ state: 'watching' })
    expect(await adapter().resolve(delivery(), runtime)).toMatchObject({
      ref: `claude:${ASKING}@local`,
      transcript: 'gone'
    })
  })

  it('leaves another computer’s asking session alone, and falls back to the publisher', async () => {
    sidecar({ state: 'watching' }, `laptop:${ASKING}`)
    expect(await adapter().resolve(delivery(), runtime)).toBeNull()
    const path = join(dir, `${PUBLISHER}.jsonl`)
    writeFileSync(path, `${JSON.stringify({ type: 'user', cwd: '/Users/maintainer/Work/x' })}\n`)
    const found = await adapter({
      findPublisher: async () => ({ path, sessionId: PUBLISHER })
    }).resolve(delivery(), runtime)
    expect(found).toEqual({
      ref: `claude:${PUBLISHER}@local`,
      folder: '/Users/maintainer/Work/x',
      transcript: 'present'
    })
  })

  it('prefers OmniOS’s binding over the sidecar', async () => {
    sidecar({ state: 'watching' })
    const owner = {
      provider: 'claude',
      conversationId: 'bound-1',
      folder: '/Work/bound'
    } as ClaimableDelivery['owner']
    expect(await adapter().resolve(delivery({ owner }), runtime)).toMatchObject({
      ref: 'claude:bound-1@local',
      folder: '/Work/bound'
    })
  })
})

describe('reviewDeliveryAdapter: delivery receipts', () => {
  it('settles a decision the asking session already read, by its decision id only', async () => {
    sidecar({ readKey: 'approved|758|2||', readAt: '2026-10-16T23:29:27+00:00' })
    expect(await adapter().resolve(delivery(), runtime)).toMatchObject({
      delivered: 'receipt',
      evidence: expect.stringContaining('decision 758')
    })
    // An earlier decision's receipt on the same page never settles a newer one.
    const newer = delivery({ context: { slug: SLUG, decisionId: 760 } })
    expect(await adapter().resolve(newer, runtime)).toMatchObject({
      ref: `claude:${ASKING}@local`
    })
  })

  it('never settles on a page mention or a handed send without this decision’s key', async () => {
    sidecar({
      state: 'read',
      sends: [{ handed: true }],
      decision: 'pending||1|no_action|2026-10-16T23:50:53Z',
      deliveredAt: '2026-10-16T23:50:56+00:00'
    })
    const resolved = await adapter().resolve(delivery(), runtime)
    expect(resolved).not.toHaveProperty('delivered')
  })

  describe('with this computer’s share record', () => {
    const entryId = 'rq-1'
    function shareRecord(status: string) {
      mocks.pass = {
        profileId: 'p',
        scope: { cloudUserId: 'u' },
        wake: {
          readRows: async () => [],
          observe: async () => ({ verdict: 'exited' }),
          now: Date.now
        },
        sleepOf: () => undefined,
        unchanged: () => true
      }
      mocks.records = [
        [
          join(dir, 'choices', '2026-10-16', '191227-plan.html'),
          {
            slug: SLUG,
            sourceReview: {
              ledgerId: `als_${'a'.repeat(24)}`,
              nativeSessionId: ASKING,
              paneKey: 'tab-1:leaf-1',
              worktreeId: 'w',
              account: 'acct',
              revision: 2,
              receipt: { decisionId: '758', entryId, attempt: 0, status }
            }
          }
        ]
      ]
    }

    it('settles when the review pass’s own queue entry delivered this decision', async () => {
      shareRecord('delivered')
      expect(await adapter().resolve(delivery(), runtime)).toMatchObject({
        delivered: 'receipt',
        evidence: expect.stringContaining(entryId)
      })
    })

    it('still holds a review-pass send it cannot confirm', async () => {
      shareRecord('uncertain')
      await expect(adapter().resolve(delivery(), runtime)).rejects.toMatchObject({
        reason: 'unverifiable'
      })
    })
  })
})
