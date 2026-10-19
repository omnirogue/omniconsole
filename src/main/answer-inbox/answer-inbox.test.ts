import { describe, expect, it } from 'vitest'
import {
  ANSWER_MAX_HOOK_COPIES,
  ANSWER_REOFFER_AFTER_MS,
  AnswerInbox,
  type HolderIdentity,
  type HookConversation
} from './answer-inbox'

const CONVERSATION = { provider: 'claude' as const, sessionId: 'conv-1' }
const HOLDER: HolderIdentity = { paneKey: 'tab-1:leaf-1', launchHash: 'launch-a', agentPid: 4242 }
const HOOK: HookConversation = {
  provider: 'claude',
  ids: ['conv-1'],
  paneKey: HOLDER.paneKey,
  launchHash: HOLDER.launchHash,
  agentPid: HOLDER.agentPid
}
const item = (id: string, text = 'answer', holder: HolderIdentity | null = HOLDER) => ({
  id,
  deliveryKey: `review:p:${id}`,
  text,
  compact: null,
  holder
})

function inbox() {
  let clock = 1_000
  const box = new AnswerInbox({ now: () => clock })
  /** One reply handed out and acknowledged by the hook script. */
  const carry = (id: string, event: 'PostToolUse' | 'Stop' | 'UserPromptSubmit', hook = HOOK) => {
    box.reserve(id, `nonce-${id}-${clock}`, event, hook)
    return box.ack(id, `nonce-${id}-${clock}`)
  }
  return { box, carry, advance: (ms: number) => (clock += ms) }
}

describe('AnswerInbox', () => {
  it('gives an item only to its conversation from the recorded holder pane, launch and agent', () => {
    const { box } = inbox()
    box.offer(CONVERSATION, item('wd-1'))
    const take = (hook: Partial<HookConversation>) =>
      box.take({ ...HOOK, ...hook }, { name: 'PostToolUse' })
    expect(take({ ids: ['conv-2'] })).toBeNull()
    expect(take({ provider: 'codex' })).toBeNull()
    // Why: a caller holding the shared hook token cannot impersonate the holder.
    expect(take({ paneKey: 'tab-2:leaf-1' })).toBeNull()
    expect(take({ launchHash: 'launch-forged' })).toBeNull()
    expect(take({ launchHash: null })).toBeNull()
    expect(take({ agentPid: 999 })).toBeNull()
    expect(take({ ids: ['CONV-1'] })?.id).toBe('wd-1')
    box.offer(CONVERSATION, item('wd-2', 'x', { ...HOLDER, agentPid: null }))
    box.withdraw('wd-1')
    expect(take({ agentPid: 999 })?.id).toBe('wd-2')
  })

  it('counts a reply as injected only on its acknowledgement; no ack offers it again', () => {
    const { box } = inbox()
    box.offer(CONVERSATION, item('wd-1'))
    box.reserve('wd-1', 'n1', 'PostToolUse', HOOK)
    expect(box.get('wd-1')?.state).toBe('sending')
    expect(box.take(HOOK, { name: 'PostToolUse' })).toBeNull()
    expect(box.ack('wd-1', 'forged')).toBe(false)
    box.release('wd-1', 'n1')
    expect(box.get('wd-1')).toMatchObject({ state: 'offered', attempts: 0 })
    // a late acknowledgement of that reply still counts: the agent did print it
    expect(box.ack('wd-1', 'n1')).toBe(true)
    expect(box.get('wd-1')).toMatchObject({ state: 'injected', attempts: 1 })
  })

  it('gives an item waiting for a resume to nobody until it is bound to the pane and launch it opened', () => {
    const { box, carry } = inbox()
    box.offer(CONVERSATION, item('wd-1', 'answer', null))
    // Why: another pane's valid launch plus the claimed session id is not the resume's pane.
    const other = { ...HOOK, paneKey: 'tab-9:leaf-1', launchHash: 'launch-b', agentPid: null }
    // a resume SessionStart from that pane, whose own launch is recorded there (Astra's case)
    const otherResume = { ...other, paneLaunchHash: 'launch-b' }
    const resumeStart = { name: 'SessionStart' as const, resume: true }
    expect(box.take(otherResume, resumeStart)).toBeNull()
    expect(box.take(other, { name: 'SessionStart' })).toBeNull()
    expect(box.take(HOOK, { name: 'SessionStart' })).toBeNull()
    box.bind('wd-1', HOLDER)
    expect(box.take(other, { name: 'SessionStart' })).toBeNull()
    expect(box.take(HOOK, { name: 'SessionStart' })?.id).toBe('wd-1')
    expect(carry('wd-1', 'PostToolUse')).toBe(true)
    // the conversation moved to another pane: offered again there
    box.bind('wd-1', { paneKey: 'tab-9:leaf-1', launchHash: 'launch-b', agentPid: null })
    expect(box.get('wd-1')).toMatchObject({ state: 'offered', holder: { paneKey: 'tab-9:leaf-1' } })
  })

  it('confirms only on a later step of the same conversation from the same holder', () => {
    const { box, carry, advance } = inbox()
    box.offer(CONVERSATION, item('wd-1'))
    carry('wd-1', 'PostToolUse')
    expect(box.confirm({ ...HOOK, ids: ['other'] })).toEqual([])
    expect(box.confirm({ ...HOOK, paneKey: 'tab-2:leaf-1' })).toEqual([])
    expect(box.confirm({ ...HOOK, launchHash: 'launch-forged' })).toEqual([])
    // a replayed record from before the injection proves nothing
    expect(box.confirm(HOOK, 900)).toEqual([])
    advance(500)
    expect(box.confirm(HOOK).map((entry) => entry.id)).toEqual(['wd-1'])
    expect(box.get('wd-1')).toMatchObject({ state: 'confirmed', confirmedAt: 1_500, attempts: 1 })
  })

  it('spends its one hook copy, and its Stop block, when handed out', () => {
    const { box } = inbox()
    box.offer(CONVERSATION, item('wd-1'))
    expect(box.take(HOOK, { name: 'Stop', stopHookActive: true })?.id).toBe('wd-1')
    // Why: the block is spent when handed out, so a lost acknowledgement never blocks again.
    box.reserve('wd-1', 'lost', 'Stop', HOOK)
    box.release('wd-1', 'lost')
    expect(box.get('wd-1')).toMatchObject({ state: 'offered', stopOffered: true, unacked: 1 })
    for (const name of ['Stop', 'PostToolUse', 'UserPromptSubmit', 'SessionStart'] as const) {
      expect(box.take(HOOK, { name })).toBeNull()
    }
  })

  it('offers an unconfirmed injection again after 10 minutes, for its typed copy only', () => {
    const { box, carry, advance } = inbox()
    box.offer(CONVERSATION, item('wd-1'))
    carry('wd-1', 'UserPromptSubmit')
    expect(box.take(HOOK, { name: 'PostToolUse' })).toBeNull()
    expect(box.take(HOOK, { name: 'SessionStart' })).toBeNull()
    advance(ANSWER_REOFFER_AFTER_MS - 1)
    expect(box.reofferStale()).toEqual([])
    advance(1)
    expect(box.reofferStale().map((entry) => entry.id)).toEqual(['wd-1'])
    expect(box.get('wd-1')).toMatchObject({ state: 'offered', attempts: 1 })
    expect(box.take(HOOK, { name: 'PostToolUse' })).toBeNull()
  })

  it('withdraws unconfirmed items but keeps confirmed ones', () => {
    const { box, carry } = inbox()
    box.offer(CONVERSATION, item('wd-1'))
    expect(box.withdraw('wd-1')?.id).toBe('wd-1')
    box.offer(CONVERSATION, item('wd-2'))
    carry('wd-2', 'Stop')
    box.confirm(HOOK)
    expect(box.withdraw('wd-2')).toBeNull()
  })

  it('hands an item out by hook at most ANSWER_MAX_HOOK_COPIES times, even across a re-offer', () => {
    const { box } = inbox()
    box.offer(CONVERSATION, item('wd-1'))
    expect(ANSWER_MAX_HOOK_COPIES).toBe(1)
    expect(box.take(HOOK, { name: 'PostToolUse' })?.id).toBe('wd-1')
    expect(box.reserve('wd-1', 'n0', 'PostToolUse', HOOK)).toBe(true)
    box.release('wd-1', 'n0')
    expect(box.get('wd-1')).toMatchObject({ state: 'offered', unacked: 1, attempts: 0 })
    expect(box.take(HOOK, { name: 'PostToolUse' })).toBeNull()
    expect(box.reserve('wd-1', 'n1', 'PostToolUse', HOOK)).toBe(false)
    // withdrawn and offered again (a re-claim): the spent copy stays spent
    box.withdraw('wd-1')
    box.offer(CONVERSATION, item('wd-1'))
    expect(box.get('wd-1')).toMatchObject({
      state: 'offered',
      unacked: 1,
      sends: [{ nonce: 'n0' }]
    })
    expect(box.take(HOOK, { name: 'PostToolUse' })).toBeNull()
    // a late acknowledgement of that copy still counts: the agent did print it
    expect(box.ack('wd-1', 'n0')).toBe(true)
    expect(box.get('wd-1')).toMatchObject({ state: 'injected', unacked: 0, attempts: 1 })
  })

  it('counts a reply cut off by a restart as never acknowledged, with its Stop block spent', () => {
    const { box } = inbox()
    box.offer(CONVERSATION, item('wd-1'))
    box.reserve('wd-1', 'n1', 'Stop', HOOK)
    const saved = structuredClone(box.get('wd-1')!)
    const restarted = new AnswerInbox()
    restarted.restore(saved)
    expect(restarted.get('wd-1')).toMatchObject({ state: 'offered', unacked: 1, stopOffered: true })
    expect(restarted.take(HOOK, { name: 'Stop' })).toBeNull()
    expect(restarted.take(HOOK, { name: 'PostToolUse' })).toBeNull()
  })

  it('an acknowledgement counts once: replayed after a re-offer it neither re-injects nor bumps attempts', () => {
    const { box, advance } = inbox()
    box.offer(CONVERSATION, item('wd-1'))
    box.reserve('wd-1', 'n1', 'PostToolUse', HOOK)
    expect(box.ack('wd-1', 'n1')).toBe(true)
    advance(ANSWER_REOFFER_AFTER_MS)
    box.reofferStale()
    expect(box.ack('wd-1', 'n1')).toBe(true)
    expect(box.get('wd-1')).toMatchObject({ state: 'offered', attempts: 1 })
    expect(box.ack('wd-1', 'never-sent')).toBe(false)
  })

  it('keeps a later step that arrives before the acknowledgement, and confirms when it lands', () => {
    const { box, advance } = inbox()
    box.offer(CONVERSATION, item('wd-1'))
    box.reserve('wd-1', 'n1', 'PostToolUse', HOOK)
    advance(100)
    // another pane, or a record from before the hand-out, proves nothing
    expect(box.confirm({ ...HOOK, paneKey: 'tab-2:leaf-1' })).toEqual([])
    expect(box.confirm(HOOK, 900)).toEqual([])
    expect(box.confirm(HOOK)).toEqual([])
    expect(box.get('wd-1')?.state).toBe('sending')
    advance(100)
    expect(box.ack('wd-1', 'n1')).toBe(true)
    expect(box.get('wd-1')).toMatchObject({ state: 'confirmed', attempts: 1, confirmedAt: 1_200 })
  })
})
