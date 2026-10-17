import { describe, expect, it, vi } from 'vitest'
import type { SourceReviewEntry } from '../artifacts/artifact-source-review-watch'
import { reviewPassOutcome } from '../answer-delivery/review-delivery-gate'
import type { WorkDeliveryApi, WorkDeliveryReceipt } from './work-delivery-api'
import {
  WORK_DELIVERY_DONE_IDLE_GAP_MS,
  WORK_DELIVERY_WORKING_GRACE_MS,
  WorkDeliveryClaimer,
  WorkDeliveryHold,
  workDeliveryQueueId,
  type QueueEntryState,
  type WorkDeliveryDeps,
  type WorkHolder,
  type WorkLoginCut,
  type WorkPane
} from './work-delivery-claimer'
import type {
  ClaimableDelivery,
  WorkDeliveryKindAdapter,
  WorkDeliveryTarget
} from './work-delivery-kind'

const DELIVERY: ClaimableDelivery = {
  key: 'jira:OMR-93:10500',
  workItem: 'jira:OMR-93',
  kind: 'jira',
  text: 'Iris: the button is still blue',
  context: {},
  state: 'pending',
  step: '',
  heldReason: null,
  attempts: 0,
  createdAt: '2026-10-11T18:00:00Z',
  eventAt: '2026-10-11T18:00:00Z',
  respawnedRef: null,
  owner: null
}
const TARGET: WorkDeliveryTarget = {
  ref: 'claude:conv-1@local',
  model: 'opus',
  effort: 'high',
  folder: '/Work/x',
  transcript: 'present'
}
const PANE: WorkPane = {
  paneKey: 'tab-1:leaf-1',
  worktreeId: 'w',
  tabId: 'tab-1',
  archived: false,
  title: 'OMR-93'
}

function harness(
  options: {
    delivery?: Partial<ClaimableDelivery>
    holder?: WorkHolder
    target?: Partial<WorkDeliveryTarget>
    extra?: ClaimableDelivery[]
    restore?: boolean
    loginCut?: WorkDeliveryDeps['loginCut']
    turns?: boolean
    agentStarts?: boolean
  } = {}
) {
  const receipts: WorkDeliveryReceipt[] = []
  const queue = new Map<string, QueueEntryState>()
  let clock = Date.parse('2026-10-11T18:00:30Z')
  let busy: boolean | null = false
  let turn: string | null = 'turn-0'
  let offered = 0
  const delivery = { ...DELIVERY, ...options.delivery }
  const api: WorkDeliveryApi = {
    // OmniOS offers it once; a claimed record is not offered again while leased.
    claimable: vi.fn(async () => ({
      status: 'ok' as const,
      value: offered++ === 0 ? [delivery, ...(options.extra ?? [])] : []
    })),
    claim: vi.fn(async (key: string) => ({
      status: 'ok' as const,
      value: [delivery, ...(options.extra ?? [])].find((d) => d.key === key)!
    })),
    receipt: vi.fn(async (_key: string, _host: string, receipt: WorkDeliveryReceipt) => {
      receipts.push(receipt)
      return { status: 'ok' as const, value: {} }
    }),
    bindOwner: vi.fn(),
    sessionState: vi.fn()
  }
  const adapter: WorkDeliveryKindAdapter = {
    kind: 'jira',
    resolve: async () => null,
    text: (d) => `reply: ${d.text}`,
    respawnBrief: (d) => `brief: ${d.text}`,
    ...(options.restore ? { restoreDeleted: async () => {} } : {})
  }
  const deps: WorkDeliveryDeps = {
    api,
    adapters: new Map([['jira', adapter]]),
    hostId: () => 'host_mac',
    hostLabel: 'MacBook',
    resolveTarget: async () => ({ ...TARGET, ...options.target }),
    findHolder: vi.fn(async () => options.holder ?? { kind: 'live' as const, pane: PANE }),
    windowAttached: () => true,
    unarchive: vi.fn(async () => {}),
    resume: vi.fn(async () => PANE),
    respawn: vi.fn(async () => ({
      ...PANE,
      paneKey: 'tab-9:leaf-1',
      ref: 'claude:new@local',
      conversationId: 'new'
    })),
    enqueue: vi.fn(async (_pane: WorkPane, _t: WorkDeliveryTarget, id: string) => {
      queue.set(id, 'queued')
      return true
    }),
    queueState: (_pane, id) => queue.get(id) ?? 'missing',
    busy: vi.fn(async () => busy),
    ...(options.turns ? { finishedTurn: vi.fn(async () => turn) } : {}),
    ...(options.agentStarts !== undefined
      ? { waitForAgent: vi.fn(async () => options.agentStarts!) }
      : {}),
    ...(options.loginCut ? { loginCut: options.loginCut } : {}),
    audit: () => {},
    restoreDeleted: vi.fn(async (a, d, t) => a.restoreDeleted?.(d, t, undefined as never)),
    now: () => clock
  }
  return {
    claimer: new WorkDeliveryClaimer(deps),
    deps,
    receipts,
    queue,
    id: workDeliveryQueueId(delivery.key),
    setBusy: (value: boolean | null) => (busy = value),
    setTurn: (value: string | null) => (turn = value),
    advance: (ms: number) => (clock += ms)
  }
}

describe('WorkDeliveryClaimer', () => {
  it('queues into a live pane, then reports typed and working only on evidence', async () => {
    const h = harness()
    await h.claimer.pass()
    expect(h.deps.enqueue).toHaveBeenCalledWith(
      PANE,
      expect.anything(),
      h.id,
      'reply: Iris: the button is still blue'
    )
    expect(h.receipts).toEqual([{ state: 'claimed', step: 'queued' }])

    h.queue.set(h.id, 'delivered')
    await h.claimer.pass()
    expect(h.receipts.at(-1)).toEqual({ state: 'typed' })
    expect(h.claimer.watched()).toEqual([DELIVERY.key])

    h.setBusy(true)
    await h.claimer.pass()
    expect(h.receipts.at(-1)).toEqual({ state: 'working' })

    h.setBusy(false)
    await h.claimer.pass()
    h.advance(WORK_DELIVERY_DONE_IDLE_GAP_MS)
    await h.claimer.pass()
    expect(h.receipts.at(-1)).toEqual({ state: 'done' })
    expect(h.claimer.watched()).toEqual([])
  })

  it('reports a turn a login failure cut off instead of done, and follows the resume to done', async () => {
    let cut: WorkLoginCut | null = null
    const h = harness({ loginCut: () => cut })
    await h.claimer.pass()
    h.queue.set(h.id, 'delivered')
    await h.claimer.pass()
    h.setBusy(true)
    await h.claimer.pass()
    expect(h.receipts.at(-1)).toEqual({ state: 'working' })

    h.setBusy(false)
    cut = { state: 'cut_off', paneKey: PANE.paneKey }
    await h.claimer.pass()
    expect(h.receipts.at(-1)).toEqual({ state: 'working', detail: { loginCut: 'cut_off' } })
    h.advance(WORK_DELIVERY_DONE_IDLE_GAP_MS * 10)
    await h.claimer.pass()
    await h.claimer.pass()
    expect(h.receipts.filter((r) => r.state === 'done')).toEqual([])
    expect(h.claimer.watched()).toEqual([DELIVERY.key])

    // the resume continued it in another pane: that pane is followed to done
    cut = { state: 'resumed', paneKey: 'tab-3:leaf-3' }
    h.setBusy(true)
    await h.claimer.pass()
    expect(h.receipts.at(-1)).toEqual({ state: 'working', detail: { loginCut: 'resumed' } })
    expect(h.deps.busy).toHaveBeenLastCalledWith(
      expect.objectContaining({ paneKey: 'tab-3:leaf-3' })
    )
    h.setBusy(false)
    await h.claimer.pass()
    h.advance(WORK_DELIVERY_DONE_IDLE_GAP_MS)
    await h.claimer.pass()
    expect(h.receipts.at(-1)).toEqual({ state: 'done' })
    expect(h.claimer.watched()).toEqual([])
  })

  it('reports a cut-off turn the resume gave up on, and lets it go without done', async () => {
    let cut: WorkLoginCut | null = null
    const h = harness({ loginCut: () => cut })
    await h.claimer.pass()
    h.queue.set(h.id, 'delivered')
    await h.claimer.pass()
    // cut off before the agent ever showed it working
    cut = { state: 'cut_off', paneKey: PANE.paneKey }
    await h.claimer.pass()
    expect(h.receipts.at(-1)).toEqual({ state: 'working', detail: { loginCut: 'cut_off' } })
    h.advance(WORK_DELIVERY_WORKING_GRACE_MS + 1)
    await h.claimer.pass()
    expect(h.receipts.filter((r) => r.state === 'held')).toEqual([])

    cut = { state: 'held', paneKey: PANE.paneKey }
    await h.claimer.pass()
    expect(h.receipts.at(-1)).toEqual({ state: 'working', detail: { loginCut: 'held' } })
    expect(h.claimer.watched()).toEqual([])
  })

  it('keeps delivering to idle panes while one waits, but reopens only one session at a time', async () => {
    const second = { ...DELIVERY, key: 'jira:OMR-85:1', workItem: 'jira:OMR-85' }
    const third = { ...DELIVERY, key: 'jira:OMR-79:1', workItem: 'jira:OMR-79' }
    const h = harness({ holder: { kind: 'none' }, extra: [second, third] })
    await h.claimer.pass()
    expect(h.deps.resume).toHaveBeenCalledOnce()
    expect(h.claimer.watched()).toEqual([DELIVERY.key])

    vi.mocked(h.deps.findHolder).mockResolvedValue({ kind: 'live', pane: PANE })
    vi.mocked(h.deps.api.claimable).mockResolvedValueOnce({ status: 'ok', value: [second, third] })
    await h.claimer.pass()
    expect(h.claimer.watched()).toEqual([DELIVERY.key, second.key, third.key])
  })

  it('brings back a deleted conversation through the adapter, then resumes it', async () => {
    const h = harness({ target: { deleted: true }, restore: true })
    await h.claimer.pass()
    expect(h.deps.findHolder).not.toHaveBeenCalled()
    expect(h.deps.resume).toHaveBeenCalledOnce()
    expect(h.receipts.map((r) => r.step)).toEqual(['restored', 'resumed', 'queued'])
  })

  it('types into an open prompt when the adapter can, and falls back to the queue when it is gone', async () => {
    const typed = harness()
    typed.deps.adapters.get('jira')!.deliverLive = async () => 'typed'
    typed.deps.deliverLive = (a, d, t) => a.deliverLive!(d, t, undefined as never)
    await typed.claimer.pass()
    expect(typed.deps.enqueue).not.toHaveBeenCalled()
    expect(typed.receipts).toEqual([{ state: 'typed' }])

    const gone = harness()
    gone.deps.adapters.get('jira')!.deliverLive = async () => 'not_open'
    gone.deps.deliverLive = (a, d, t) => a.deliverLive!(d, t, undefined as never)
    await gone.claimer.pass()
    expect(gone.deps.enqueue).toHaveBeenCalledOnce()
  })

  it('delivers a review decision the review pass proved unsent, and only follows one it queued live', async () => {
    const passed: SourceReviewEntry = {
      sourceKey: '/work/plan.md',
      slug: 'plan',
      sourceReview: {
        ledgerId: 'als_0123456789abcdef01234567',
        nativeSessionId: 'conv-1',
        paneKey: 'tab-1:leaf-1',
        worktreeId: 'w',
        account: 'account',
        revision: 2,
        receipt: { decisionId: '7', entryId: 'artifact-review:e', attempt: 0, status: 'queued' }
      }
    }
    // The review adapter's resolve and deliverLive, over the pass's own queue entry.
    const review = (passState: QueueEntryState, holder: WorkHolder) => {
      const h = harness({ holder })
      let follow = false
      h.deps.resolveTarget = async () => {
        const outcome = await reviewPassOutcome(
          passed,
          7,
          { state: () => passState, withdraw: () => true },
          async () => holder.kind === 'live'
        )
        if (typeof outcome !== 'string') {
          throw new WorkDeliveryHold(outcome.reason, outcome.message)
        }
        follow = outcome === 'follow'
        return TARGET
      }
      h.deps.adapters.get('jira')!.deliverLive = async () => (follow ? 'typed' : 'not_open')
      h.deps.deliverLive = (a, d, t) => a.deliverLive!(d, t, undefined as never)
      return h
    }

    const unsent = review('failed-unsent', { kind: 'none' })
    await unsent.claimer.pass()
    expect(unsent.deps.resume).toHaveBeenCalledOnce()
    expect(unsent.deps.enqueue).toHaveBeenCalledOnce()
    expect(unsent.receipts.map((r) => r.step)).toEqual(['resumed', 'queued'])

    const queuedLive = review('queued', { kind: 'live', pane: PANE })
    await queuedLive.claimer.pass()
    expect(queuedLive.deps.enqueue).not.toHaveBeenCalled()
    expect(queuedLive.receipts).toEqual([{ state: 'typed' }])

    const delivered = review('delivered', { kind: 'none' })
    await delivered.claimer.pass()
    expect(delivered.deps.resume).not.toHaveBeenCalled()
    expect(delivered.deps.enqueue).not.toHaveBeenCalled()
    expect(delivered.receipts).toEqual([
      expect.objectContaining({ state: 'held', heldReason: 'unverifiable' })
    ])
  })

  it('holds login_failed instead of typing into a signed-out account', async () => {
    const h = harness()
    h.deps.loginReady = async () => ({
      ready: false,
      reason: 'Claude account x needs a new login.'
    })
    await h.claimer.pass()
    expect(h.deps.enqueue).not.toHaveBeenCalled()
    expect(h.receipts).toEqual([
      expect.objectContaining({ state: 'held', heldReason: 'login_failed' })
    ])
  })

  it('unarchives an archived live pane before queueing', async () => {
    const h = harness({ holder: { kind: 'live', pane: { ...PANE, archived: true } } })
    await h.claimer.pass()
    expect(h.deps.unarchive).toHaveBeenCalledOnce()
    expect(h.receipts.map((r) => r.step)).toEqual(['unarchived', 'queued'])
  })

  it('resumes the same conversation when nothing holds it', async () => {
    const h = harness({ holder: { kind: 'none' } })
    await h.claimer.pass()
    expect(h.deps.resume).toHaveBeenCalledOnce()
    expect(h.deps.respawn).not.toHaveBeenCalled()
    expect(h.receipts.map((r) => r.step)).toEqual(['resumed', 'queued'])
  })

  it('respawns once with the brief when the transcript is gone', async () => {
    const h = harness({ holder: { kind: 'none' } })
    vi.mocked(h.deps.resume).mockRejectedValueOnce(
      new WorkDeliveryHold('transcript_gone', 'No transcript')
    )
    await h.claimer.pass()
    const operationId = vi.mocked(h.deps.respawn).mock.calls[0][3]
    expect(h.deps.respawn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'brief: Iris: the button is still blue',
      expect.stringMatching(/^\d{13}-[0-9a-f]{32}$/)
    )
    // recorded before the launch, then confirmed with the same ref
    expect(h.receipts.slice(0, 2)).toEqual([
      { state: 'claimed', step: 'claimed', respawnedRef: `op:${operationId}` },
      expect.objectContaining({
        state: 'typed',
        step: 'respawned',
        respawnedRef: `op:${operationId}`
      })
    ])
    expect(h.deps.enqueue).not.toHaveBeenCalled()
  })

  it('starts no fresh session when OmniOS did not record it first', async () => {
    const h = harness({ holder: { kind: 'none' } })
    vi.mocked(h.deps.resume).mockRejectedValueOnce(
      new WorkDeliveryHold('transcript_gone', 'No transcript')
    )
    vi.mocked(h.deps.api.receipt).mockResolvedValueOnce({
      status: 'refused',
      code: 'not_lease_holder'
    })
    await h.claimer.pass()
    expect(h.deps.respawn).not.toHaveBeenCalled()
    expect(h.receipts.at(-1)).toMatchObject({ state: 'held', heldReason: 'error' })
  })

  it('records a launch refused before the spawn as not_started, and the next claim tries a new one', async () => {
    const h = harness({
      holder: { kind: 'none' },
      delivery: { respawnedRef: 'op:refused', step: 'not_started', state: 'held' }
    })
    vi.mocked(h.deps.resume).mockRejectedValueOnce(
      new WorkDeliveryHold('transcript_gone', 'No transcript')
    )
    vi.mocked(h.deps.respawn).mockRejectedValueOnce(
      new WorkDeliveryHold('account_at_limit', 'No verified account has room')
    )
    await h.claimer.pass()
    const operationId = vi.mocked(h.deps.respawn).mock.calls[0][3]
    expect(`op:${operationId}`).not.toBe('op:refused')
    expect(h.receipts).toEqual([
      { state: 'claimed', step: 'claimed', respawnedRef: `op:${operationId}` },
      {
        state: 'held',
        step: 'not_started',
        heldReason: 'account_at_limit',
        detail: { message: 'No verified account has room' }
      }
    ])
  })

  it('never retries a launch whose outcome is unknown', async () => {
    const h = harness({ holder: { kind: 'none' } })
    vi.mocked(h.deps.resume).mockRejectedValueOnce(
      new WorkDeliveryHold('transcript_gone', 'No transcript')
    )
    vi.mocked(h.deps.respawn).mockRejectedValueOnce(new Error('The host stopped answering'))
    await h.claimer.pass()
    // The write-ahead step stays `claimed`, so the next claim holds instead of launching again.
    expect(h.receipts.at(-1)).toMatchObject({ state: 'held', heldReason: 'unverifiable' })
    expect(h.receipts.at(-1)).not.toHaveProperty('step')
    const again = harness({
      holder: { kind: 'none' },
      delivery: { respawnedRef: h.receipts[0].respawnedRef!, step: 'claimed', state: 'held' }
    })
    await again.claimer.pass()
    expect(again.deps.respawn).not.toHaveBeenCalled()
    expect(again.receipts).toEqual([
      expect.objectContaining({ state: 'held', heldReason: 'unverifiable' })
    ])
  })

  it('holds instead of starting a second session when the respawned one is not open', async () => {
    const h = harness({
      holder: { kind: 'none' },
      delivery: { respawnedRef: 'claude:new@local', state: 'held' }
    })
    await h.claimer.pass()
    expect(h.deps.resume).not.toHaveBeenCalled()
    expect(h.deps.respawn).not.toHaveBeenCalled()
    expect(h.receipts).toEqual([
      expect.objectContaining({ state: 'held', heldReason: 'unverifiable' })
    ])
  })

  it('never retypes a re-claimed typed delivery', async () => {
    const h = harness({ delivery: { state: 'typed', step: 'queued' } })
    h.queue.set(workDeliveryQueueId(DELIVERY.key), 'delivered')
    await h.claimer.pass()
    expect(h.deps.enqueue).not.toHaveBeenCalled()
    expect(h.claimer.watched()).toEqual([DELIVERY.key])
  })

  it('holds a stranded sending entry as unverifiable instead of replaying it', async () => {
    const h = harness({ delivery: { state: 'claimed', step: 'queued' } })
    h.queue.set(workDeliveryQueueId(DELIVERY.key), 'sending')
    await h.claimer.pass()
    expect(h.deps.enqueue).not.toHaveBeenCalled()
    expect(h.receipts).toEqual([
      expect.objectContaining({ state: 'held', heldReason: 'unverifiable' })
    ])
  })

  it('holds protection for a deleted conversation', async () => {
    const h = harness({ target: { deleted: true } })
    await h.claimer.pass()
    expect(h.deps.findHolder).not.toHaveBeenCalled()
    expect(h.receipts).toEqual([
      expect.objectContaining({ state: 'held', heldReason: 'protection' })
    ])
  })

  it("holds with the adapter's own reason when resolving or typing says why it must wait", async () => {
    const resolving = harness()
    resolving.deps.resolveTarget = async () => {
      throw new WorkDeliveryHold('busy', 'Its session is being closed.')
    }
    await resolving.claimer.pass()
    expect(resolving.deps.findHolder).not.toHaveBeenCalled()
    expect(resolving.receipts).toEqual([
      expect.objectContaining({
        state: 'held',
        heldReason: 'busy',
        detail: { message: 'Its session is being closed.' }
      })
    ])

    const typing = harness()
    typing.deps.adapters.get('jira')!.deliverLive = async () => {
      throw new WorkDeliveryHold('error', 'Reload the window.')
    }
    typing.deps.deliverLive = (a, d, t) => a.deliverLive!(d, t, undefined as never)
    await typing.claimer.pass()
    expect(typing.deps.enqueue).not.toHaveBeenCalled()
    expect(typing.receipts).toEqual([
      expect.objectContaining({ state: 'held', heldReason: 'error' })
    ])

    const unknown = harness()
    unknown.deps.adapters.get('jira')!.deliverLive = async () => {
      throw new Error('relay timed out')
    }
    unknown.deps.deliverLive = (a, d, t) => a.deliverLive!(d, t, undefined as never)
    await unknown.claimer.pass()
    expect(unknown.receipts).toEqual([
      expect.objectContaining({ state: 'held', heldReason: 'unverifiable' })
    ])
  })

  it('holds unverifiable when typed but never seen working', async () => {
    const h = harness()
    await h.claimer.pass()
    h.queue.set(h.id, 'delivered')
    await h.claimer.pass()
    h.advance(WORK_DELIVERY_WORKING_GRACE_MS + 1)
    await h.claimer.pass()
    expect(h.receipts.at(-1)).toMatchObject({ state: 'held', heldReason: 'unverifiable' })
  })

  it('reports working and done for a turn too short to be seen busy', async () => {
    const h = harness({ turns: true })
    await h.claimer.pass()
    h.queue.set(h.id, 'delivered')
    h.setTurn('turn-1')
    await h.claimer.pass()
    expect(h.receipts.at(-1)).toEqual({ state: 'typed' })
    h.advance(WORK_DELIVERY_DONE_IDLE_GAP_MS)
    await h.claimer.pass()
    expect(h.receipts.slice(-2)).toEqual([{ state: 'working' }, { state: 'done' }])
    expect(h.claimer.watched()).toEqual([])
  })

  it('does not count the turn it was queued behind as its own', async () => {
    const h = harness({ turns: true })
    h.setBusy(true)
    await h.claimer.pass()
    h.setBusy(false)
    h.setTurn('turn-ahead')
    await h.claimer.pass()
    h.queue.set(h.id, 'delivered')
    await h.claimer.pass()
    h.advance(WORK_DELIVERY_DONE_IDLE_GAP_MS)
    await h.claimer.pass()
    expect(h.receipts.map((r) => r.state)).toEqual(['claimed', 'typed'])
    h.setTurn('turn-own')
    await h.claimer.pass()
    h.advance(WORK_DELIVERY_DONE_IDLE_GAP_MS)
    await h.claimer.pass()
    expect(h.receipts.slice(-2)).toEqual([{ state: 'working' }, { state: 'done' }])
  })

  it('waits for a reopened agent before queueing', async () => {
    const h = harness({ holder: { kind: 'none' }, agentStarts: true })
    await h.claimer.pass()
    expect(h.deps.waitForAgent).toHaveBeenCalledOnce()
    expect(h.receipts.map((r) => r.step)).toEqual(['resumed', 'queued'])
  })

  it('holds busy, not unverifiable, when a reopened agent has not started and nothing was sent', async () => {
    const h = harness({ holder: { kind: 'none' }, agentStarts: false })
    vi.mocked(h.deps.enqueue).mockResolvedValueOnce(false)
    await h.claimer.pass()
    expect(h.receipts.at(-1)).toMatchObject({ state: 'held', heldReason: 'busy' })
  })

  it('follows a re-claimed typed delivery whose short turn already finished to done', async () => {
    const h = harness({ delivery: { state: 'typed', step: 'queued' }, turns: true })
    h.queue.set(h.id, 'delivered')
    await h.claimer.pass()
    await h.claimer.pass()
    h.advance(WORK_DELIVERY_DONE_IDLE_GAP_MS)
    await h.claimer.pass()
    expect(h.deps.enqueue).not.toHaveBeenCalled()
    expect(h.receipts).toEqual([{ state: 'working' }, { state: 'done' }])
  })
})
