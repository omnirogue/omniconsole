import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import type { SessionPendingDelivery } from '../../shared/session-pending-delivery-types'
import { SessionManageRefusal } from './session-manage-refusal'
import {
  SessionPendingDeliveries,
  type SessionPendingDeliveryDeps
} from './session-pending-deliveries'
import {
  createSessionPendingDeliveriesStore,
  SESSION_PENDING_DELIVERIES_FILE
} from './session-pending-deliveries-store'
import { manageEntry } from './session-manage-test-fixtures'

const actor = { kind: 'pane' as const, paneKey: 'tab-9:leaf-9', title: 'Planner' }
const busy = manageEntry({ state: 'working' })
const free = manageEntry({ state: 'idle', agentForeground: true })

let dir: string
let clock: number

function held(overrides: Partial<SessionPendingDelivery> = {}): SessionPendingDelivery {
  return {
    id: 'held-1',
    createdAt: clock,
    expiresAt: clock + 30 * 60_000,
    actor,
    target: { paneKey: 'tab-1:leaf-1', tabId: 'tab-1', title: 'Parser fix' },
    text: 'Also cover the export path',
    reason: 'same files as its parser change',
    state: 'waiting',
    ...overrides
  }
}

function engine(
  target: { current: SessionManageEntry | null; bound?: boolean },
  overrides: Partial<SessionPendingDeliveryDeps> = {}
) {
  const deliver = vi.fn(async () => ({ entryId: 'queue-1', summary: 'Sent the held prompt.' }))
  const report = vi.fn()
  const pending = new SessionPendingDeliveries({
    store: createSessionPendingDeliveriesStore(dir, () => clock),
    observe: async () =>
      target.current ? { entry: target.current, bound: target.bound === true } : null,
    deliver,
    report,
    now: () => clock,
    ...overrides
  })
  return { pending, deliver, report }
}

function onDisk(): SessionPendingDelivery[] {
  return JSON.parse(readFileSync(join(dir, SESSION_PENDING_DELIVERIES_FILE), 'utf8')).deliveries
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pending-deliveries-'))
  clock = Date.UTC(2026, 8, 25, 12)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('prompts held for a busy session', () => {
  it('waits while the owner works and delivers exactly once the moment it is free', async () => {
    const target = { current: busy as SessionManageEntry | null }
    const { pending, deliver, report } = engine(target)
    await pending.start()
    await pending.hold(held())
    await pending.noteTurnFinished('tab-1:leaf-1')
    expect(deliver).not.toHaveBeenCalled()
    expect(pending.list()[0]).toMatchObject({ state: 'waiting', note: 'Waiting: working.' })

    target.current = free
    // A turn signal and the sweep arrive together: one send.
    await Promise.all([pending.noteTurnFinished('tab-1:leaf-1'), pending.sweep(), pending.sweep()])
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(onDisk()[0]).toMatchObject({ state: 'delivered', entryId: 'queue-1' })
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ state: 'delivered' }))
    await pending.sweep()
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('survives a restart: a waiting prompt is still sent once, and one cut off mid-send is never re-sent', async () => {
    const target = { current: busy as SessionManageEntry | null }
    const first = engine(target)
    await first.pending.start()
    await first.pending.hold(held())
    await first.pending.hold(held({ id: 'held-2', state: 'delivering' }))

    target.current = free
    const second = engine(target)
    await second.pending.start()
    const states = Object.fromEntries(onDisk().map((entry) => [entry.id, entry.state]))
    expect(states).toEqual({ 'held-1': 'delivered', 'held-2': 'unknown' })
    expect(second.deliver).toHaveBeenCalledTimes(1)
    expect(second.deliver).toHaveBeenCalledWith(expect.objectContaining({ id: 'held-1' }))
    expect(second.report).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'held-2', state: 'unknown' })
    )
  })

  it('reports back unsent when its window ends, and never launches anything', async () => {
    const target = { current: busy as SessionManageEntry | null }
    const { pending, deliver, report } = engine(target)
    await pending.start()
    await pending.hold(held())
    const waiting = pending.waitFor('held-1')
    clock += 31 * 60_000
    await pending.sweep()
    const settled = await waiting
    expect(settled.state).toBe('expired')
    expect(settled.note).toContain('was not free within 30 minutes, so the prompt was not sent')
    expect(deliver).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ state: 'expired' }))
  })

  it('keeps an unsent expiry on top of session pending until its requester has seen it', async () => {
    const { pending } = engine({ current: busy })
    await pending.start()
    await pending.hold(held())
    await pending.hold(held({ id: 'held-2', expiresAt: clock + 120 * 60_000 }))
    clock += 31 * 60_000
    await pending.sweep()

    const other = { kind: 'pane' as const, paneKey: 'tab-5:leaf-5', title: 'Reviewer' }
    const seenByOther = await pending.listFor(other, false)
    expect(seenByOther.map((entry) => [entry.id, entry.state])).toEqual([
      ['held-1', 'expired'],
      ['held-2', 'waiting']
    ])
    expect(pending.list().find((entry) => entry.id === 'held-1')?.seenAt).toBeUndefined()

    const seenByRequester = await pending.listFor(actor, false)
    expect(seenByRequester.map((entry) => entry.id)).toEqual(['held-1', 'held-2'])
    expect(seenByRequester[0]?.seenAt).toBeUndefined()
    expect(onDisk().find((entry) => entry.id === 'held-1')?.seenAt).toBe(clock)

    expect((await pending.listFor(actor, false)).map((entry) => entry.id)).toEqual(['held-2'])
    expect((await pending.listFor(actor, true)).map((entry) => entry.id)).toEqual([
      'held-1',
      'held-2'
    ])
  })

  it('surfaces a send cut off by a restart (unknown) the same way', async () => {
    const { pending } = engine({ current: busy })
    await pending.start()
    await pending.hold(held({ state: 'delivering' }))
    const restarted = engine({ current: busy })
    await restarted.pending.start()
    const listed = await restarted.pending.listFor(actor, false)
    expect(listed).toEqual([expect.objectContaining({ id: 'held-1', state: 'unknown' })])
    expect(await restarted.pending.listFor(actor, false)).toEqual([])
  })

  it('keeps holding when the free owner is not open to a new prompt yet', async () => {
    const target = { current: free as SessionManageEntry | null }
    const { pending, report } = engine(target, {
      deliver: vi.fn(async () => {
        throw new SessionManageRefusal('Its latest reply ends on a question. Nothing was sent.')
      })
    })
    await pending.start()
    await pending.hold(held())
    await pending.sweep()
    expect(pending.list()[0]).toMatchObject({
      state: 'waiting',
      note: 'Not yet: Its latest reply ends on a question. Nothing was sent.'
    })
    expect(report).not.toHaveBeenCalled()
  })

  it.each([
    ['its row is gone', null, 'No sidebar row holds pane tab-1:leaf-1'],
    ['it exited', manageEntry({ verdict: 'exited', state: 'exited' }), 'exited before it was free'],
    ['another computer runs it', manageEntry({ hostId: 'runtime:env-1' }), 'not on this computer']
  ])('refuses and reports when %s', async (_name, current, words) => {
    const { pending, deliver } = engine({ current: current as SessionManageEntry | null })
    await pending.start()
    await pending.hold(held())
    await pending.sweep()
    expect(pending.list()[0]!.state).toBe('refused')
    expect(pending.list()[0]!.note).toContain(words)
    expect(deliver).not.toHaveBeenCalled()
  })

  it.each([
    ['queued prompts', { queueLength: 1 }, 'prompts waiting in its queue'],
    ['its own open steps', { pendingSteps: ['Ship it'] }, 'open next steps'],
    ['Keep going', { keepGoing: true }, 'Keep going drives it'],
    ['an unproven terminal', { agentForeground: false }, 'could not be proven']
  ])('does not treat an idle owner with %s as free', async (_name, overrides, words) => {
    const { pending, deliver } = engine({
      current: manageEntry({ state: 'idle', agentForeground: true, ...overrides })
    })
    await pending.start()
    await pending.hold(held())
    await pending.sweep()
    expect(deliver).not.toHaveBeenCalled()
    expect(pending.list()[0]!.note).toContain(words)
  })

  it('does not treat an idle owner a session chain drives as free (the assign rule)', async () => {
    const target = { current: free as SessionManageEntry | null, bound: true }
    const { pending, deliver } = engine(target)
    await pending.start()
    await pending.hold(held({ kind: 'assign' }))
    await pending.sweep()
    expect(deliver).not.toHaveBeenCalled()
    expect(pending.list()[0]!.note).toBe('Waiting: an outcome run or session chain drives it.')
    target.bound = false
    await pending.sweep()
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ kind: 'assign' }))
  })

  it('cancels a waiting prompt and reports it', async () => {
    const { pending, deliver, report } = engine({ current: busy })
    await pending.start()
    await pending.hold(held())
    const cancelled = await pending.cancel('held-1')
    expect(cancelled.state).toBe('cancelled')
    await expect(pending.cancel('held-1')).rejects.toThrow('cancelled already')
    expect(deliver).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ state: 'cancelled' }))
  })
})
