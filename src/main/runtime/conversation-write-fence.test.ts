import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationSource } from '../../shared/conversation-source'
import {
  closeWriteFence,
  isWriteFenceOpen,
  noteWriteFencePty,
  openWriteFence,
  onConversationWriteInvalidation,
  revokeWriteFencesWhere,
  recheckWriteFences,
  setWriteFenceRevocationSink
} from './conversation-write-fence'
import { followConversationChangesForWriteFences } from './conversation-write-fence-feeds'
import type { TurnSignal } from '../next-steps/next-step-turn-signal'

const PANE: ConversationSource = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' }
const OTHER: ConversationSource = { worktreeId: 'wt', paneKey: 'tab-2:leaf-1', kind: 'pty' }
const CHAT: ConversationSource = {
  worktreeId: 'wt',
  paneKey: 'agent-session:s1',
  kind: 'structured',
  sessionId: 's1'
}

type StatusEmit = (event: { type: string; session: { sessionId: string } }) => void

/** Feeds a test can fire by hand: hook reports, turn signals and chat status events. */
function feeds() {
  const fire: {
    hook?: (report: { paneKey: string }) => void
    turn?: (signal: TurnSignal) => void
    status?: StatusEmit
  } = {}
  const host = {
    subscribeStatus: (subscriber: { emit: StatusEmit }) => {
      fire.status = subscriber.emit
      return () => {}
    }
  }
  const stop = followConversationChangesForWriteFences({
    subscribeHookReports: (listener) => {
      fire.hook = listener
      return () => {}
    },
    subscribeTurnSignals: (listener) => {
      fire.turn = listener
      return () => {}
    },
    getHost: () => host as never,
    subscribeHostChanges: () => () => {}
  })
  return {
    hook: (paneKey: string, report: object = {}) => fire.hook?.({ paneKey, ...report }),
    turn: (signal: TurnSignal) => fire.turn?.(signal),
    status: (sessionId: string) => fire.status?.({ type: 'status', session: { sessionId } }),
    stop
  }
}

afterEach(() => setWriteFenceRevocationSink(null))

describe('conversation write fences', () => {
  it('stays open until revoked or closed; an unknown token is never open', () => {
    const token = openWriteFence(PANE, () => true)
    expect(isWriteFenceOpen(token)).toBe(true)
    closeWriteFence(token)
    expect(isWriteFenceOpen(token)).toBe(false)
    expect(isWriteFenceOpen('never-opened')).toBe(false)
  })

  it('is revoked by a hook report or turn signal for its pane, and only its pane', () => {
    const { hook, turn, stop } = feeds()
    const mine = openWriteFence(PANE, () => true)
    const other = openWriteFence(OTHER, () => true)
    hook(PANE.paneKey)
    expect(isWriteFenceOpen(mine)).toBe(false)
    expect(isWriteFenceOpen(other)).toBe(true)
    turn({ kind: 'busy', conversation: OTHER })
    expect(isWriteFenceOpen(other)).toBe(false)
    stop()
  })

  it('tolerating its pane’s turns, is revoked only by a report it refuses or by input', () => {
    const { hook, turn, status, stop } = feeds()
    const tolerance = {
      toleratesHookReport: (report: unknown) => (report as { ok?: boolean }).ok === true,
      toleratesPaneTurns: true
    }
    const token = openWriteFence(PANE, () => true, tolerance)
    hook(PANE.paneKey, { ok: true })
    turn({ kind: 'busy', conversation: PANE })
    expect(isWriteFenceOpen(token)).toBe(true)
    hook(PANE.paneKey)
    expect(isWriteFenceOpen(token)).toBe(false)
    const typed = openWriteFence(PANE, () => true, tolerance)
    revokeWriteFencesWhere((source) => source.paneKey === PANE.paneKey)
    expect(isWriteFenceOpen(typed)).toBe(false)
    const chat = openWriteFence(CHAT, () => true, tolerance)
    status('s1')
    expect(isWriteFenceOpen(chat)).toBe(false)
    stop()
  })

  it('never tolerates turns without judging the reports they come from', () => {
    const { turn, stop } = feeds()
    const token = openWriteFence(PANE, () => true, { toleratesPaneTurns: true })
    turn({ kind: 'busy', conversation: PANE })
    expect(isWriteFenceOpen(token)).toBe(false)
    stop()
  })

  it('is revoked by a chat status change for its session', () => {
    const { status, stop } = feeds()
    const chat = openWriteFence(CHAT, () => true)
    status('s2')
    expect(isWriteFenceOpen(chat)).toBe(true)
    status('s1')
    expect(isWriteFenceOpen(chat)).toBe(false)
    stop()
  })

  it('is revoked by a store change after which its conversation no longer reads as checked', () => {
    let holds = true
    const token = openWriteFence(PANE, () => holds)
    recheckWriteFences()
    expect(isWriteFenceOpen(token)).toBe(true)
    holds = false
    recheckWriteFences()
    expect(isWriteFenceOpen(token)).toBe(false)
  })

  it('pushes each revocation to every PTY a write under it went to', () => {
    const sink = vi.fn()
    setWriteFenceRevocationSink(sink)
    const { hook, stop } = feeds()
    const token = openWriteFence(PANE, () => true)
    noteWriteFencePty(token, 'pty-1')
    hook(PANE.paneKey)
    expect(sink).toHaveBeenCalledWith('pty-1', token)
    stop()
  })
  it('revokes owner fences before observers and isolates a failed observer from later ones', () => {
    const token = openWriteFence(PANE, () => true)
    const sink = vi.fn()
    setWriteFenceRevocationSink(sink)
    noteWriteFencePty(token, 'pty-1')
    const beforeThrow = vi.fn()
    const removeBroken = onConversationWriteInvalidation(() => {
      beforeThrow(isWriteFenceOpen(token), sink.mock.calls)
      throw new Error('observer failed')
    })
    const observed = vi.fn()
    const removeLater = onConversationWriteInvalidation(observed)
    try {
      expect(() =>
        revokeWriteFencesWhere((source) => source.paneKey === PANE.paneKey)
      ).not.toThrow()
      expect(isWriteFenceOpen(token)).toBe(false)
      expect(observed).toHaveBeenCalledOnce()
      expect(beforeThrow).toHaveBeenCalledWith(false, [['pty-1', token]])
    } finally {
      removeBroken()
      removeLater()
    }
  })
})
