// Why: drives the real work-delivery claimer through hook-first routing with fake panes and hook
// events (PHASE1-SPEC §3, acceptance A4–A6): working, idle, exited and late answers, the receipt's
// path and latency, re-offers, and an off setting that leaves every call exactly as today.
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { AnswerDeliveryPilotRecord } from '../../shared/answer-delivery-pilot-report'
import type { WorkDeliveryApi, WorkDeliveryReceipt } from '../work-delivery/work-delivery-api'
import {
  WorkDeliveryClaimer,
  WorkDeliveryHold,
  workDeliveryQueueId,
  type QueueEntryState,
  type WorkDeliveryDeps,
  type WorkHolder,
  type WorkPane
} from '../work-delivery/work-delivery-claimer'
import type {
  ClaimableDelivery,
  WorkDeliveryKindAdapter,
  WorkDeliveryTarget
} from '../work-delivery/work-delivery-kind'
import { ANSWER_REOFFER_AFTER_MS, AnswerInbox } from './answer-inbox'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { createHookAnswerReplies } from './hook-answer-reply'
import {
  HOOK_FIRST_WAITING_MESSAGE,
  HOOK_FIRST_WAKE_LINE,
  HOOK_FIRST_WAKE_WAIT_MS,
  HOOK_FIRST_WORKING_WAIT_MS,
  wakeQueueId,
  type HookFirstSnapshot
} from './hook-first-route'
import { HookFirstRouter } from './hook-first-router'

const TEXT = [
  '[OmniOS decision] Approved: revision 2 of "Plan"',
  'Do now: carry out the plan exactly as approved in revision 2.',
  'Read the saved decision any time: omni artifacts status plan --json'
].join('\n')
const DELIVERY: ClaimableDelivery = {
  key: 'review:plan:d42',
  workItem: 'review:plan',
  kind: 'review',
  text: TEXT,
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
const TARGET: WorkDeliveryTarget = { ref: 'claude:conv-1@local', transcript: 'present' }
const PANE: WorkPane = {
  paneKey: 'tab-1:leaf-1',
  worktreeId: 'w',
  tabId: 'tab-1',
  archived: false,
  title: 'Plan'
}
const ID = workDeliveryQueueId(DELIVERY.key)
const LAUNCH = createHash('sha256').update('launch-1').digest('hex')

type Options = {
  enabled?: () => boolean
  route?: boolean
  busy?: boolean | null
  holder?: () => WorkHolder
  text?: string
  ref?: string
  resume?: () => Promise<WorkPane>
  accepts?: (id: string, text: string) => boolean
  /** No launch recorded for the pane (a pane this runtime did not launch). */
  unrecorded?: boolean
  /** What successive reads of the pane's recorded owner return (the last one repeats). */
  identities?: Partial<{ launchHash: string; agentPid: number | null }>[]
  /** What successive holder lookups return (the last one repeats). */
  holders?: WorkHolder[]
}

/** The next value of a sequence; its last value repeats. */
function nextOf<T>(values: T[]): T | undefined {
  return values.length > 1 ? values.shift() : values[0]
}

function harness(options: Options = {}) {
  let clock = Date.parse('2026-10-17T21:00:00Z')
  const now = () => clock
  const receipts: WorkDeliveryReceipt[] = []
  const queue = new Map<string, QueueEntryState>()
  const typed: { id: string; text: string }[] = []
  const log: AnswerDeliveryPilotRecord[] = []
  const saved: HookFirstSnapshot[] = []
  const cancelled: string[] = []
  let busy = options.busy === undefined ? true : options.busy
  let offered = 0
  const delivery = { ...DELIVERY, ...(options.text ? { text: options.text } : {}) }
  const api: WorkDeliveryApi = {
    claimable: vi.fn(async () => ({
      status: 'ok' as const,
      value: offered++ === 0 ? [delivery] : []
    })),
    claim: vi.fn(async () => ({ status: 'ok' as const, value: delivery })),
    receipt: vi.fn(async (_key: string, _host: string, receipt: WorkDeliveryReceipt) => {
      receipts.push(receipt)
      return { status: 'ok' as const, value: {} }
    }),
    bindOwner: vi.fn(),
    sessionState: vi.fn()
  }
  const adapter: WorkDeliveryKindAdapter = {
    kind: 'review',
    resolve: async () => null,
    text: (d) => d.text
  }
  const base: WorkDeliveryDeps = {
    api,
    adapters: new Map([['review', adapter]]),
    hostId: () => 'host_mac',
    hostLabel: 'MacBook',
    resolveTarget: async () => ({ ...TARGET, ...(options.ref ? { ref: options.ref } : {}) }),
    findHolder: vi.fn(
      async (): Promise<WorkHolder> =>
        (options.holders && nextOf(options.holders)) ??
        options.holder?.() ?? { kind: 'live' as const, pane: PANE }
    ),
    windowAttached: () => true,
    unarchive: vi.fn(async () => {}),
    resume: vi.fn(options.resume ?? (async () => PANE)),
    respawn: vi.fn(async () => {
      throw new Error('no respawn in these tests')
    }),
    enqueue: vi.fn(
      async (_pane: WorkPane, _target: WorkDeliveryTarget, id: string, text: string) => {
        if (options.accepts && !options.accepts(id, text)) {
          return false
        }
        typed.push({ id, text })
        queue.set(id, 'queued')
        return true
      }
    ),
    queueState: (_pane, id) => queue.get(id) ?? 'missing',
    busy: vi.fn(async () => busy),
    audit: () => {},
    now
  }
  const enabled = options.enabled ?? (() => true)
  let router: HookFirstRouter | null = null
  const inbox = new AnswerInbox({ now, onChange: (item) => router?.noteItemChange(item) })
  router = new HookFirstRouter({
    inbox,
    enabled,
    now,
    log: (record) => log.push(record),
    onChange: (urgent) => urgent && saved.push(structuredClone(router!.snapshot())),
    cancelQueued: (_pane, id) => cancelled.push(id),
    holderIdentity: async (pane) =>
      options.unrecorded
        ? null
        : {
            paneKey: pane.paneKey,
            launchHash: LAUNCH,
            agentPid: null,
            ...(options.identities && nextOf(options.identities))
          }
  })
  const deps = options.route === false ? base : router.wrap(base)
  const replies = createHookAnswerReplies(inbox, { enabled })
  /**
   * One accepted hook of `pane`. Its reply is acknowledged (printed) when `ack` is true, left
   * outstanding when false, and expired as the listener does after its wait when `lost`.
   */
  const hook = (
    payload: Record<string, unknown>,
    pane = PANE.paneKey,
    { ack = true as boolean | 'lost', launchToken = 'launch-1' } = {}
  ) => {
    const reply = replies.reply({
      source: 'claude',
      body: { payload: { session_id: 'conv-1', ...payload } },
      event: { paneKey: pane, launchToken, connectionId: null } as AgentHookEventPayload,
      pointer: null,
      deliverable: () => true
    })
    if (reply && ack === true) {
      replies.ack(reply.ack)
    } else if (reply && ack === 'lost') {
      replies.expire(reply.ack)
    }
    return reply?.body ?? null
  }
  return {
    claimer: new WorkDeliveryClaimer(deps),
    base,
    deps,
    inbox,
    router,
    receipts,
    queue,
    typed,
    log,
    saved,
    cancelled,
    hook,
    setBusy: (value: boolean | null) => (busy = value),
    advance: (ms: number) => (clock += ms)
  }
}

const typedReceipt = (h: { receipts: WorkDeliveryReceipt[] }) =>
  h.receipts.find((receipt) => receipt.state === 'typed')

describe('hook-first routing in the work-delivery claimer', () => {
  it('working: a PostToolUse carries it, nothing is typed, the receipt has path and latency', async () => {
    const h = harness({ busy: true })
    await h.claimer.pass()
    expect(h.typed).toEqual([])
    expect(h.receipts).toEqual([{ state: 'claimed', step: 'queued' }])

    h.advance(40_000)
    expect(JSON.parse(h.hook({ hook_event_name: 'PostToolUse' })!)).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: TEXT }
    })
    await h.claimer.pass()
    expect(typedReceipt(h)).toBeUndefined()

    h.hook({ hook_event_name: 'PreToolUse' })
    await h.claimer.pass()
    expect(typedReceipt(h)).toEqual({
      state: 'typed',
      path: 'hook_post_tool',
      latencyMs: 40_000,
      detail: { path: 'hook_post_tool', latencyMs: 40_000 }
    })
    expect(h.receipts.at(-1)).toEqual({ state: 'working' })
    expect(h.typed).toEqual([])
    expect(h.log.map((line) => [line.outcome, line.path, line.attempts])).toEqual([
      ['open', null, 0],
      ['confirmed', 'hook_post_tool', 1]
    ])
  })

  it('working: a Stop blocks once with the answer and the continued turn confirms it', async () => {
    const h = harness({ busy: true })
    await h.claimer.pass()
    h.advance(5_000)
    expect(JSON.parse(h.hook({ hook_event_name: 'Stop', stop_hook_active: false })!)).toEqual({
      decision: 'block',
      reason: TEXT
    })
    expect(h.hook({ hook_event_name: 'Stop', stop_hook_active: true })).toBeNull()
    await h.claimer.pass()
    expect(typedReceipt(h)).toMatchObject({ path: 'hook_stop', latencyMs: 5_000 })
    expect(h.typed).toEqual([])
  })

  it('idle: types only the fixed wake line, and UserPromptSubmit carries the answer', async () => {
    const h = harness({ busy: false })
    await h.claimer.pass()
    expect(h.typed).toEqual([{ id: wakeQueueId(ID), text: HOOK_FIRST_WAKE_LINE }])

    h.advance(3_000)
    const reply = JSON.parse(
      h.hook({ hook_event_name: 'UserPromptSubmit', prompt: HOOK_FIRST_WAKE_LINE })!
    )
    expect(reply.hookSpecificOutput).toEqual({
      hookEventName: 'UserPromptSubmit',
      additionalContext: TEXT
    })
    h.hook({ hook_event_name: 'Stop', stop_hook_active: false })
    await h.claimer.pass()
    expect(typedReceipt(h)).toMatchObject({ path: 'hook_prompt', latencyMs: 3_000 })
    expect(h.typed.map((entry) => entry.text)).not.toContain(TEXT)
  })

  it('exited: once bound to the resumed pane, its SessionStart carries it and the wake line confirms', async () => {
    let early: string | null = 'unset'
    const h = harness({
      holder: () => ({ kind: 'none' }),
      busy: false,
      resume: async () => {
        // Why: before the resume returns, nobody knows its pane and launch, so nobody gets it.
        early = h.hook({ hook_event_name: 'SessionStart', source: 'resume' })
        return PANE
      }
    })
    await h.claimer.pass()
    expect(early).toBeNull()
    expect(h.inbox.get(ID)).toMatchObject({
      state: 'offered',
      holder: { paneKey: PANE.paneKey, launchHash: LAUNCH }
    })
    expect(h.typed).toEqual([{ id: wakeQueueId(ID), text: HOOK_FIRST_WAKE_LINE }])
    h.advance(2_000)
    const late = h.hook({ hook_event_name: 'SessionStart', source: 'resume' })
    expect(JSON.parse(late!).hookSpecificOutput).toEqual({
      hookEventName: 'SessionStart',
      additionalContext: TEXT
    })
    expect(h.hook({ hook_event_name: 'UserPromptSubmit', prompt: HOOK_FIRST_WAKE_LINE })).toBeNull()
    await h.claimer.pass()
    expect(typedReceipt(h)).toMatchObject({ path: 'hook_session_start', latencyMs: 2_000 })
  })

  it("a resumed conversation's answer goes only to the pane and launch that resume opened", async () => {
    const OTHER = 'tab-2:leaf-1'
    const during: (string | null)[] = []
    const h = harness({
      holder: () => ({ kind: 'none' }),
      busy: false,
      resume: async () => {
        // another pane with its own valid launch, claiming the conversation's session id
        during.push(
          h.hook({ hook_event_name: 'SessionStart', source: 'resume' }, OTHER, {
            launchToken: 'launch-2'
          }),
          h.hook({ hook_event_name: 'PostToolUse' }, OTHER, { launchToken: 'launch-2' })
        )
        return PANE
      }
    })
    await h.claimer.pass()
    expect(during).toEqual([null, null])
    for (const event of ['SessionStart', 'PostToolUse', 'UserPromptSubmit', 'Stop']) {
      expect(
        h.hook({ hook_event_name: event, source: 'resume' }, OTHER, { launchToken: 'launch-2' })
      ).toBeNull()
    }
    expect(h.inbox.get(ID)).toMatchObject({ state: 'offered', attempts: 0, unacked: 0 })
    expect(h.hook({ hook_event_name: 'UserPromptSubmit', prompt: HOOK_FIRST_WAKE_LINE })).toContain(
      'Approved: revision 2'
    )
  })

  it('a resume into a pane with no recorded launch types the answer as today', async () => {
    const h = harness({ holder: () => ({ kind: 'none' }), busy: true, unrecorded: true })
    await h.claimer.pass()
    expect(h.typed).toEqual([{ id: ID, text: TEXT }])
    expect(h.inbox.isEmpty()).toBe(true)
  })

  it('a resume that is refused takes the offered answer back', async () => {
    const h = harness({
      holder: () => ({ kind: 'none' }),
      resume: async () => {
        throw new WorkDeliveryHold('transcript_gone', 'gone')
      }
    })
    await h.claimer.pass()
    expect(h.inbox.isEmpty()).toBe(true)
    expect(h.log.at(-1)?.outcome).toBe('withdrawn')
  })

  it('not taken within 5 minutes while working: typed exactly as today, path typed_fallback', async () => {
    const h = harness({ busy: true })
    await h.claimer.pass()
    h.advance(HOOK_FIRST_WORKING_WAIT_MS - 1)
    await h.router.tick()
    expect(h.typed).toEqual([])

    h.advance(1)
    await h.router.tick()
    expect(h.typed).toEqual([{ id: ID, text: TEXT }])
    expect(h.inbox.isEmpty()).toBe(true)
    expect(h.hook({ hook_event_name: 'PostToolUse' })).toBeNull()

    h.queue.set(ID, 'delivered')
    await h.claimer.pass()
    expect(typedReceipt(h)).toMatchObject({
      path: 'typed_fallback',
      latencyMs: HOOK_FIRST_WORKING_WAIT_MS
    })
    expect(h.log.at(-1)).toMatchObject({ outcome: 'typed_fallback', path: 'typed_fallback' })
  })

  it('not taken within 2 minutes of a wake: typed exactly as today', async () => {
    const h = harness({ busy: false })
    await h.claimer.pass()
    h.advance(HOOK_FIRST_WAKE_WAIT_MS)
    await h.router.tick()
    expect(h.typed).toEqual([
      { id: wakeQueueId(ID), text: HOOK_FIRST_WAKE_LINE },
      { id: ID, text: TEXT }
    ])
  })

  it('injected but unconfirmed for 10 minutes: its one typed copy goes, never a second hook copy', async () => {
    const h = harness({ busy: true })
    await h.claimer.pass()
    h.hook({ hook_event_name: 'PostToolUse' })
    h.advance(ANSWER_REOFFER_AFTER_MS - 1)
    await h.router.tick()
    expect(h.typed).toEqual([])
    h.advance(1)
    await h.router.tick()
    expect(h.typed).toEqual([{ id: ID, text: TEXT }])
    expect(h.hook({ hook_event_name: 'PostToolUse' })).toBeNull()
    expect(h.log.at(-1)).toMatchObject({ outcome: 'typed_fallback', attempts: 1 })
  })

  it('keeps a waiting answer across an app restart', async () => {
    const h = harness({ busy: true })
    await h.claimer.pass()
    const restoredHarness = harness({ busy: true })
    restoredHarness.router.restore(structuredClone(h.saved.at(-1)!))
    expect(restoredHarness.deps.queueState(PANE, ID)).toBe('queued')
    expect(restoredHarness.hook({ hook_event_name: 'PostToolUse' })).toContain(
      'Approved: revision 2'
    )
    restoredHarness.hook({ hook_event_name: 'PreToolUse' })
    expect(restoredHarness.deps.queueState(PANE, ID)).toBe('delivered')
  })

  it('types at once what cannot ride a hook: too long without a full-answer command, or not local', async () => {
    const long = harness({ text: `[OmniOS message] From Sal:\n${'z'.repeat(1500)}` })
    await long.claimer.pass()
    expect(long.typed).toHaveLength(1)
    expect(long.inbox.isEmpty()).toBe(true)

    const remote = harness({ ref: 'claude:conv-1@ssh:box1' })
    await remote.claimer.pass()
    expect(remote.typed).toEqual([{ id: ID, text: TEXT }])
    expect(remote.inbox.isEmpty()).toBe(true)
  })

  it('setting off: every call and receipt is exactly what the claimer does today', async () => {
    const run = async (options: Options) => {
      const h = harness({ busy: true, ...options })
      await h.claimer.pass()
      h.queue.set(ID, 'delivered')
      await h.claimer.pass()
      return {
        receipts: h.receipts,
        typed: h.typed,
        enqueue: vi.mocked(h.base.enqueue).mock.calls,
        empty: h.inbox.isEmpty(),
        hook: h.hook({ hook_event_name: 'Stop', stop_hook_active: false }),
        log: h.log
      }
    }
    const today = await run({ route: false })
    const off = await run({ enabled: () => false })
    expect(off).toEqual(today)
    expect(off.typed).toEqual([{ id: ID, text: TEXT }])
    expect(off).toMatchObject({ empty: true, hook: null, log: [] })
    expect(off.receipts.some((receipt) => 'path' in receipt)).toBe(false)
  })

  it('never types into a pane that no longer runs the conversation; it is offered again instead', async () => {
    let holder: WorkHolder = { kind: 'live', pane: PANE }
    const h = harness({ busy: true, holder: () => holder })
    await h.claimer.pass()
    holder = { kind: 'live', pane: { ...PANE, paneKey: 'tab-1:leaf-reused' } }
    h.advance(HOOK_FIRST_WORKING_WAIT_MS)
    await h.router.tick()
    expect(h.typed).toEqual([])
    expect(h.inbox.isEmpty()).toBe(true)
    expect(h.deps.queueState(PANE, ID)).toBe('failed-unsent')
    expect(h.log.map((line) => line.outcome)).toEqual(['open'])
    await h.claimer.pass()
    expect(h.receipts.at(-1)).toEqual({
      state: 'released',
      detail: { message: 'not sent; offered again' }
    })
  })

  it('saves the typed handoff before the enqueue, so a restart never restores it beside a typed copy', async () => {
    let atEnqueue: HookFirstSnapshot | null = null
    const h = harness({
      busy: true,
      accepts: (id) => {
        if (id === ID) {
          atEnqueue = structuredClone(h.saved.at(-1)!)
        }
        return true
      }
    })
    await h.claimer.pass()
    h.advance(HOOK_FIRST_WORKING_WAIT_MS)
    await h.router.tick()
    expect(atEnqueue!.routes[0]).toMatchObject({ id: ID, phase: 'fallback_sending' })
    expect(atEnqueue!.items).toEqual([])

    // crashed right after the queue took it: the queue owns it, the inbox stays empty
    const typedCopy = harness({ busy: true })
    typedCopy.router.restore(structuredClone(atEnqueue!))
    typedCopy.queue.set(ID, 'queued')
    expect(typedCopy.deps.queueState(PANE, ID)).toBe('queued')
    expect(typedCopy.inbox.isEmpty()).toBe(true)
    expect(typedCopy.hook({ hook_event_name: 'PostToolUse' })).toBeNull()
    // crashed before it: proven unsent, so the claimer releases it to be offered again
    const unsent = harness({ busy: true })
    unsent.router.restore(structuredClone(atEnqueue!))
    expect(unsent.deps.queueState(PANE, ID)).toBe('failed-unsent')
  })

  it('setting turned off: only answers never carried are typed; a carried one still confirms', async () => {
    let on = true
    const h = harness({ busy: true, enabled: () => on })
    await h.claimer.pass()
    const waiting = structuredClone(h.saved.at(-1)!)
    h.hook({ hook_event_name: 'PostToolUse' })
    expect(h.inbox.get(ID)?.state).toBe('injected')
    on = false
    h.advance(ANSWER_REOFFER_AFTER_MS)
    await h.router.tick()
    // neither typed (a duplicate) nor offered again: it waits for its confirmation
    expect(h.typed).toEqual([])
    expect(h.inbox.get(ID)?.state).toBe('injected')
    h.hook({ hook_event_name: 'PreToolUse' })
    expect(h.deps.queueState(PANE, ID)).toBe('delivered')

    // restored after a restart with the setting off and never carried: typed, never lost
    const restarted = harness({ busy: true, enabled: () => false })
    restarted.router.restore(waiting)
    expect(restarted.hook({ hook_event_name: 'PostToolUse' })).toBeNull()
    await restarted.router.tick()
    expect(restarted.typed).toEqual([{ id: ID, text: TEXT }])
  })

  it('routes nothing to a pane with no recorded launch, and a forged launch token gets nothing', async () => {
    const unrecorded = harness({ busy: true, unrecorded: true })
    await unrecorded.claimer.pass()
    expect(unrecorded.typed).toEqual([{ id: ID, text: TEXT }])
    expect(unrecorded.inbox.isEmpty()).toBe(true)

    const h = harness({ busy: true })
    await h.claimer.pass()
    expect(
      h.hook({ hook_event_name: 'PostToolUse' }, PANE.paneKey, { launchToken: 'forged' })
    ).toBeNull()
    expect(h.inbox.get(ID)).toMatchObject({ state: 'offered', attempts: 0 })
  })

  it('types the fallback and the wake line with the conversation guard for the write itself', async () => {
    const idle = harness({ busy: false })
    await idle.claimer.pass()
    idle.advance(HOOK_FIRST_WAKE_WAIT_MS)
    await idle.router.tick()
    const guards = vi.mocked(idle.base.enqueue).mock.calls.map((call) => [call[2], call[5]])
    expect(guards).toEqual([
      [wakeQueueId(ID), { guardConversation: true }],
      [ID, { guardConversation: true }]
    ])
  })

  it('a reply the hook never acknowledged is not injected; it waits and is typed later', async () => {
    const h = harness({ busy: true })
    await h.claimer.pass()
    expect(h.hook({ hook_event_name: 'PostToolUse' }, PANE.paneKey, { ack: false })).toContain(
      'Approved: revision 2'
    )
    expect(h.inbox.get(ID)?.state).toBe('sending')
    h.hook({ hook_event_name: 'PreToolUse' })
    expect(h.deps.queueState(PANE, ID)).toBe('queued')
  })

  it('logs a typed fallback only once the queue took it; a refused one stays open', async () => {
    let accept = false
    const h = harness({ busy: true, accepts: (id) => id !== ID || accept })
    await h.claimer.pass()
    h.advance(HOOK_FIRST_WORKING_WAIT_MS)
    await h.router.tick()
    expect(h.typed).toEqual([])
    expect(h.deps.queueState(PANE, ID)).toBe('failed-unsent')
    expect(h.log.map((line) => line.outcome)).toEqual(['open'])

    // offered again by a later claim: the same delivery in the pilot log
    accept = true
    await h.deps.findHolder(TARGET)
    expect(await h.deps.enqueue(PANE, TARGET, ID, TEXT, DELIVERY)).toBe(true)
    h.advance(HOOK_FIRST_WORKING_WAIT_MS)
    await h.router.tick()
    expect(h.typed).toEqual([{ id: ID, text: TEXT }])
    expect(h.log.map((line) => [line.outcome, line.claimedAt])).toEqual([
      ['open', h.log[0]!.claimedAt],
      ['open', h.log[0]!.claimedAt],
      ['typed_fallback', h.log[0]!.claimedAt]
    ])
  })

  it('takes back a wake line still queued once a hook carried the answer', async () => {
    const h = harness({ busy: false })
    await h.claimer.pass()
    expect(h.typed).toEqual([{ id: wakeQueueId(ID), text: HOOK_FIRST_WAKE_LINE }])
    // the agent started a turn of its own before the wake line went out
    h.hook({ hook_event_name: 'PostToolUse' })
    expect(h.cancelled).toEqual([wakeQueueId(ID)])
    h.hook({ hook_event_name: 'PreToolUse' })
    expect(h.cancelled).toEqual([wakeQueueId(ID)])
  })

  it('a hold while the answer still waits for a hook says so instead of "held busy"', async () => {
    const h = harness({ busy: true })
    await h.claimer.pass()
    h.hook({ hook_event_name: 'PostToolUse' })
    h.advance(10 * 60_000 + 1)
    await h.claimer.pass()
    expect(h.receipts.at(-1)).toMatchObject({
      state: 'held',
      heldReason: 'busy',
      detail: { message: HOOK_FIRST_WAITING_MESSAGE }
    })
  })

  it('an acknowledgement lost: one uncertain hook copy, then one guarded typed copy, then nothing', async () => {
    const h = harness({ busy: true })
    await h.claimer.pass()
    const handed: string[] = []
    const step = (payload: Record<string, unknown>) => {
      if (h.hook(payload, PANE.paneKey, { ack: 'lost' })) {
        handed.push(String(payload.hook_event_name))
      }
    }
    step({ hook_event_name: 'Stop', stop_hook_active: false })
    step({ hook_event_name: 'Stop', stop_hook_active: true })
    step({ hook_event_name: 'Stop', stop_hook_active: false })
    step({ hook_event_name: 'PostToolUse' })
    step({ hook_event_name: 'UserPromptSubmit', prompt: 'next' })
    step({ hook_event_name: 'SessionStart', source: 'compact' })
    expect(handed).toEqual(['Stop'])
    // the uncertain state was saved as it happened, so a restart cannot hand it out as new
    expect(h.saved.at(-1)!.items[0]).toMatchObject({
      state: 'offered',
      unacked: 1,
      attempts: 0,
      stopOffered: true
    })

    await h.router.tick()
    expect(h.typed).toEqual([{ id: ID, text: TEXT }])
    expect(vi.mocked(h.base.enqueue).mock.calls.at(-1)?.[5]).toEqual({ guardConversation: true })
    h.advance(HOOK_FIRST_WORKING_WAIT_MS)
    await h.router.tick()
    step({ hook_event_name: 'PostToolUse' })
    expect(h.typed).toHaveLength(1)
    expect(handed).toHaveLength(1)
    expect(h.log.at(-1)).toMatchObject({ outcome: 'typed_fallback', attempts: 0 })
  })

  it('the pane changed owner between the holder lookup and the handover: nothing is bound or sent', async () => {
    const LAUNCH_2 = createHash('sha256').update('launch-2').digest('hex')
    const OTHER: WorkPane = { ...PANE, paneKey: 'tab-1:leaf-other' }
    const cases: { name: string; options: Options }[] = [
      {
        name: 'relaunched with a new launch',
        options: { identities: [LAUNCH, LAUNCH_2].map((launchHash) => ({ launchHash })) }
      },
      {
        name: 'same launch, another agent process',
        options: { identities: [{ agentPid: 101 }, { agentPid: 202 }] }
      },
      {
        name: 'same launch, the conversation now runs elsewhere',
        options: {
          holders: [
            { kind: 'live', pane: PANE },
            { kind: 'live', pane: OTHER }
          ]
        }
      }
    ]
    for (const { name, options } of cases) {
      const h = harness({ busy: false, ...options })
      await h.claimer.pass()
      expect({ name, typed: h.typed }).toEqual({ name, typed: [] })
      expect(h.inbox.isEmpty()).toBe(true)
      expect(h.receipts.at(-1)).toMatchObject({ state: 'held', heldReason: 'unverifiable' })
      // the replacement, with its own launch and the victim's session id, gets nothing
      expect(
        h.hook({ hook_event_name: 'PostToolUse' }, PANE.paneKey, { launchToken: 'launch-2' })
      ).toBeNull()
      expect(h.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'x' })).toBeNull()
    }
  })

  it('the resumed pane changed owner before the handover: nothing is bound or sent', async () => {
    const LAUNCH_2 = createHash('sha256').update('launch-2').digest('hex')
    const h = harness({
      holder: () => ({ kind: 'none' }),
      busy: false,
      identities: [LAUNCH, LAUNCH_2].map((launchHash) => ({ launchHash }))
    })
    await h.claimer.pass()
    expect(h.typed).toEqual([])
    expect(h.inbox.isEmpty()).toBe(true)
    expect(
      h.hook({ hook_event_name: 'SessionStart', source: 'resume' }, PANE.paneKey, {
        launchToken: 'launch-2'
      })
    ).toBeNull()
  })

  it('a held answer is not re-bound to a pane whose owner changed before a later handover', async () => {
    const LAUNCH_2 = createHash('sha256').update('launch-2').digest('hex')
    const h = harness({
      busy: true,
      // claim: lookup, handover; re-claim: lookup, then the pane is relaunched before the handover
      identities: [LAUNCH, LAUNCH, LAUNCH, LAUNCH_2].map((launchHash) => ({ launchHash }))
    })
    await h.claimer.pass()
    expect(h.inbox.get(ID)?.holder).toMatchObject({ launchHash: LAUNCH })
    await h.deps.findHolder(TARGET)
    expect(await h.deps.enqueue(PANE, TARGET, ID, TEXT, DELIVERY)).toBe(false)
    expect(h.inbox.isEmpty()).toBe(true)
    expect(h.typed).toEqual([])
    expect(
      h.hook({ hook_event_name: 'PostToolUse' }, PANE.paneKey, { launchToken: 'launch-2' })
    ).toBeNull()
  })

  it('restored after a crash mid-reply: that reply counts as unacknowledged', async () => {
    const h = harness({ busy: true })
    await h.claimer.pass()
    h.hook({ hook_event_name: 'Stop', stop_hook_active: false }, PANE.paneKey, { ack: false })
    const atCrash = structuredClone(h.saved.at(-1)!)
    expect(atCrash.items[0]).toMatchObject({ state: 'sending', stopOffered: true })
    const restarted = harness({ busy: true })
    restarted.router.restore(atCrash)
    expect(restarted.inbox.get(ID)).toMatchObject({ state: 'offered', unacked: 1 })
    expect(restarted.hook({ hook_event_name: 'Stop', stop_hook_active: false })).toBeNull()
    restarted.hook({ hook_event_name: 'PostToolUse' }, PANE.paneKey, { ack: 'lost' })
    await restarted.router.tick()
    expect(restarted.typed).toEqual([{ id: ID, text: TEXT }])
  })
})
