import { describe, expect, it, vi } from 'vitest'
import { CodexStructuredLiveInput } from './codex-structured-live-input'
import { CodexAppServerRequestError } from './codex-app-server-connection'
import { USER_MESSAGE } from './codex-structured-session-adapter.fixtures'
import { codexItemIdentity } from './codex-thread-item-identity'
import { CodexTurnOrdinals } from './codex-turn-ordinals'

function harness() {
  const live = new CodexStructuredLiveInput()
  live.observe('turn/started', { turn: { id: 'active' } })
  const request = vi.fn(async () => ({ turnId: 'active' }))
  const host = {
    threadId: 'thread',
    connection: { request },
    options: new Map([['model', 'different']]),
    turnIdWaiters: []
  }
  const input = { clientMessageId: 'correction', body: USER_MESSAGE }
  return { live, request, host, input }
}

describe('live Codex steering', () => {
  it('accepts the exact turn receipt without waiting for an echo or applying next-turn options', async () => {
    const { live, request, host, input } = harness()
    expect(await live.steer(host, input)).toEqual({
      state: 'accepted',
      providerIdentity: { provider: 'omni', clientMessageId: 'correction' }
    })
    expect(request).toHaveBeenCalledExactlyOnceWith(
      'turn/steer',
      {
        threadId: 'thread',
        expectedTurnId: 'active',
        clientUserMessageId: 'omni-steer:correction',
        input: [{ type: 'text', text: 'ship it' }]
      },
      { timeoutMs: 10000 }
    )
    expect(live.steeringMessageForTurn('active')).toBe('correction')
    expect(live.steeringMessageForTurn('other')).toBeUndefined()
  })
  it('keeps a newer turn when an older completion arrives', () => {
    const { live } = harness()
    live.observe('turn/started', { turn: { id: 'new' } })
    live.observe('turn/completed', { turn: { id: 'active' } })
    expect(live.activeTurnId).toBe('new')
    live.observe('turn/completed', { turn: { id: 'new' } })
    expect(live.activeTurnId).toBeNull()
  })
  it('does not silently start or interrupt after a rejected steer', async () => {
    const { live, request, host, input } = harness()
    request.mockRejectedValue(
      new CodexAppServerRequestError('turn/steer', -32602, 'no active turn')
    )
    expect(await live.steer(host, input)).toEqual({ state: 'rejected', reason: 'no active turn' })
    expect(request).toHaveBeenCalledOnce()
  })
  it('keeps a mismatched receipt unconfirmed', async () => {
    const { live, request, host, input } = harness()
    request.mockResolvedValue({ turnId: 'other' })
    expect(await live.steer(host, input)).toMatchObject({ state: 'unknown' })
  })
  it('does not dispatch after the active turn completed', async () => {
    const { live, request, host, input } = harness()
    live.observe('turn/completed', { turn: { id: 'active' } })
    expect(await live.steer(host, input)).toMatchObject({ state: 'rejected' })
    expect(request).not.toHaveBeenCalled()
  })
  it('preserves message ordinals and steering identities across renumbered history', () => {
    const identify = (suffix: string) => {
      const ordinals = new CodexTurnOrdinals()
      return ['userMessage', 'agentMessage', 'userMessage', 'agentMessage'].map((type, index) =>
        codexItemIdentity({
          threadId: 'thread',
          turnId: 'active',
          ordinals,
          item: {
            type,
            id: `${suffix}-${index}`,
            clientId: index === 2 ? 'omni-steer:correction' : null
          }
        })
      )
    }
    const identities = identify('live')
    expect(identities[2]).toEqual({ provider: 'omni', clientMessageId: 'correction' })
    expect(identities[3]).toEqual({
      provider: 'codex',
      threadId: 'thread',
      turnId: 'active',
      ordinal: 3
    })
    expect(identify('resumed')).toEqual(identities)
  })
})
