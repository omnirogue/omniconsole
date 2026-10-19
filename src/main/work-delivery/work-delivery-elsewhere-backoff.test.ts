import { describe, expect, it, vi } from 'vitest'
import type { WorkDeliveryApi, WorkDeliveryReceipt } from './work-delivery-api'
import {
  WorkDeliveryClaimer,
  type WorkDeliveryDeps,
  type WorkHolder
} from './work-delivery-claimer'
import { elsewhereWaitMs } from './work-delivery-elsewhere-backoff'
import type {
  ClaimableDelivery,
  WorkDeliveryOwner,
  WorkDeliveryResolution
} from './work-delivery-kind'

const MINUTE = 60_000
const START = Date.parse('2026-10-17T12:00:00Z')
const DELIVERY: ClaimableDelivery = {
  key: 'review:1a13b941da0295e8e:d42',
  workItem: 'review:1a13b941da0295e8e',
  kind: 'review',
  text: 'Approved',
  context: {},
  state: 'pending',
  step: '',
  heldReason: null,
  attempts: 0,
  createdAt: null,
  eventAt: null,
  respawnedRef: null,
  owner: null
}
const OWNER: WorkDeliveryOwner = {
  hostId: 'host_mac',
  hostLabel: 'MacBook',
  provider: 'claude',
  accountId: '',
  conversationId: 'conv-1',
  model: '',
  effort: '',
  folder: '/Work/x',
  paneKey: '',
  title: 'Report'
}
const NOT_WOKEN = '“Report” cannot be verified, so it is not woken a second time.'
const PANE = {
  paneKey: 'tab-1:leaf-1',
  worktreeId: 'w',
  tabId: 'tab-1',
  archived: false,
  title: 'x'
}

/** OmniOS offers the held delivery on every pass; this computer decides when to claim it. */
function harness(options: {
  owner?: WorkDeliveryOwner | (() => WorkDeliveryOwner | null)
  resolution: () => WorkDeliveryResolution
  holder?: () => WorkHolder
}) {
  let clock = START
  const ownerNow = () =>
    (typeof options.owner === 'function' ? options.owner() : options.owner) ?? null
  const offer = (): ClaimableDelivery => ({ ...DELIVERY, owner: ownerNow() })
  const claims: number[] = []
  const audits: string[] = []
  const receipts: WorkDeliveryReceipt[] = []
  const api: WorkDeliveryApi = {
    claimable: vi.fn(async () => ({ status: 'ok' as const, value: [offer()] })),
    claim: vi.fn(async () => {
      claims.push((clock - START) / MINUTE)
      return { status: 'ok' as const, value: offer() }
    }),
    receipt: vi.fn(async (_key: string, _host: string, receipt: WorkDeliveryReceipt) => {
      receipts.push(receipt)
      return { status: 'ok' as const, value: {} }
    }),
    bindOwner: vi.fn(),
    sessionState: vi.fn()
  }
  const deps: WorkDeliveryDeps = {
    api,
    adapters: new Map([['review', { kind: 'review', resolve: async () => null, text: () => 'x' }]]),
    hostId: () => 'host_mac',
    hostLabel: 'MacBook',
    resolveTarget: async () => options.resolution(),
    findHolder: vi.fn(async () => options.holder?.() ?? { kind: 'live' as const, pane: PANE }),
    windowAttached: () => true,
    unarchive: vi.fn(async () => {}),
    resume: vi.fn(async () => PANE),
    respawn: vi.fn(),
    enqueue: vi.fn(async () => true),
    queueState: () => 'queued',
    busy: vi.fn(async () => null),
    audit: (_delivery, summary) => audits.push(summary),
    now: () => clock
  }
  const claimer = new WorkDeliveryClaimer(deps)
  /** One pass a minute (the real claimer polls every 15 s) for `minutes`. */
  const run = async (minutes: number) => {
    for (let i = 0; i < minutes; i += 1) {
      await claimer.pass()
      clock += MINUTE
    }
  }
  return { claims, audits, receipts, run, deps }
}

const target = () => ({ ref: 'claude:conv-1@local', transcript: 'present' as const })

describe('work-delivery backoff for work this computer does not hold', () => {
  it('waits 15 min, then 30, 60, 120 and at most 4 h between claims', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map((step) => elsewhereWaitMs(step) / MINUTE)).toEqual([
      15, 30, 60, 120, 240, 240, 240
    ])
  })

  it('claims a not_found delivery on the backoff schedule and logs once per step (A4)', async () => {
    const h = harness({ resolution: () => null })
    await h.run(12 * 60)
    expect(h.claims).toEqual([0, 15, 45, 105, 225, 465, 705])
    expect(h.audits).toEqual([
      'held (not_found): No session is bound to this work on this computer. It is tried here again in 15 min.',
      'held (not_found): No session is bound to this work on this computer. It is tried here again in 30 min.',
      'held (not_found): No session is bound to this work on this computer. It is tried here again in 1 h.',
      'held (not_found): No session is bound to this work on this computer. It is tried here again in 2 h.',
      'held (not_found): No session is bound to this work on this computer. It is tried here again every 4 h.'
    ])
    // Never dropped: OmniOS gets the same held receipt at every claim.
    expect(h.receipts).toHaveLength(h.claims.length)
    expect(h.receipts.every((r) => r.state === 'held' && r.heldReason === 'not_found')).toBe(true)
  })

  it('backs off a delivery whose session is never woken a second time (A4)', async () => {
    const h = harness({
      resolution: target,
      holder: () => ({ kind: 'blocked', reason: NOT_WOKEN })
    })
    await h.run(4 * 60)
    expect(h.claims).toEqual([0, 15, 45, 105, 225])
    expect(h.audits).toHaveLength(5)
    expect(h.audits[0]).toBe(`held (unverifiable): ${NOT_WOKEN} It is tried here again in 15 min.`)
    expect(h.receipts.every((r) => r.heldReason === 'unverifiable')).toBe(true)
  })

  it('keeps the old cadence for work bound to a conversation on this computer (A5)', async () => {
    const notFound = harness({ owner: OWNER, resolution: () => null })
    await notFound.run(30)
    expect(notFound.claims).toHaveLength(30)
    expect(notFound.audits).toEqual(
      Array(30).fill('held (not_found): No session is bound to this work on this computer.')
    )
    const notWoken = harness({
      owner: OWNER,
      resolution: target,
      holder: () => ({ kind: 'blocked', reason: NOT_WOKEN })
    })
    await notWoken.run(10)
    expect(notWoken.claims).toHaveLength(10)
    expect(notWoken.audits).toEqual(Array(10).fill(`held (unverifiable): ${NOT_WOKEN}`))
  })

  it('backs off work bound here without a conversation, or bound to another computer', async () => {
    for (const owner of [
      { ...OWNER, conversationId: '' },
      { ...OWNER, hostId: 'host_studio' }
    ]) {
      const h = harness({ owner, resolution: () => null })
      await h.run(60)
      expect(h.claims).toEqual([0, 15, 45])
    }
  })

  it('claims at once when the offer becomes bound to a conversation here (A5)', async () => {
    let owner: WorkDeliveryOwner | null = null
    const h = harness({ owner: () => owner, resolution: () => null })
    await h.run(5)
    expect(h.claims).toEqual([0])
    owner = OWNER
    await h.run(3)
    // Bound here: every offer is claimed and logged as before, from the next pass on.
    expect(h.claims).toEqual([0, 5, 6, 7])
    expect(h.audits.slice(1)).toEqual(
      Array(3).fill('held (not_found): No session is bound to this work on this computer.')
    )
    owner = null
    await h.run(20)
    // Unbound again: the backoff starts over at its first step.
    expect(h.claims).toEqual([0, 5, 6, 7, 8, 23])
  })

  it('delivers at its next claim once the session is here', async () => {
    let here = false
    const h = harness({ resolution: () => (here ? target() : null) })
    await h.run(20)
    expect(h.claims).toEqual([0, 15])
    here = true
    await h.run(26)
    expect(h.claims).toEqual([0, 15, 45])
    expect(h.deps.enqueue).toHaveBeenCalledTimes(1)
    expect(h.receipts.at(-1)).toEqual({ state: 'claimed', step: 'queued' })
  })
})
