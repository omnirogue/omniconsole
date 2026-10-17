/**
 * Finished turns of chat (structured) sessions, Claude and Codex alike: the host's status feed
 * pushes a `working → idle` edge, and the full reply is read from that session's journal.
 */

import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import { structuredConversationSource } from '../../shared/conversation-source'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import {
  classifyStructuredStatus,
  isUnsettledStructuredTurn,
  type FinishedTurn,
  type TurnSignal
} from './next-step-turn-signal'

type StructuredTurnHost = Pick<
  StructuredAgentSessionHost,
  'subscribeStatus' | 'turnState' | 'outcomeSource' | 'liveSessionStatusSummaries'
>

const SUBSCRIBER_ID = 'next-step-suggestions'

/** The finished reply in full when the journal holds it; the projection's preview otherwise. */
async function withFullReply(host: StructuredTurnHost, turn: FinishedTurn): Promise<FinishedTurn> {
  try {
    const context = await host.outcomeSource.context(
      turn.conversation.paneKey,
      turn.conversation.worktreeId
    )
    return context?.summary.trim()
      ? { ...turn, lastAssistantMessage: context.summary, replyComplete: true }
      : turn
  } catch {
    return turn
  }
}

function signalFor(
  host: StructuredTurnHost,
  previous: AgentSessionStatusSummary['status'] | undefined,
  summary: AgentSessionStatusSummary
): TurnSignal {
  return classifyStructuredStatus(previous, summary, host.turnState(summary.sessionId))
}

type SessionTrack = {
  status: AgentSessionStatusSummary['status']
  /** The last idle edge found the turn unsettled; later updates re-read it without a new edge. */
  unsettled?: boolean
  /** Turn already signalled, so one reply is signalled once. */
  signalledTurnKey?: string
  /** The journal read for a turn not yet signalled. Replaced only by a different turn. */
  read?: { turnKey: string; token: number; held?: FinishedTurn }
}

export function followStructuredTurns(options: {
  getHost: () => StructuredTurnHost | null
  subscribeHostChanges: (listener: (host: StructuredTurnHost | null) => void) => () => void
  onSignal: (signal: TurnSignal) => void
}): (() => void) & { tracked: () => string[] } {
  const sessions = new Map<string, SessionTrack>()
  // Why one counter for every session and host: a token never repeats, so a read that outlives
  // its session, a snapshot or a host swap can never match a later one.
  let lastToken = 0
  let detach: (() => void) | null = null

  const signalTurn = (track: SessionTrack, turn: FinishedTurn): void => {
    track.signalledTurnKey = turn.turnKey
    track.read = undefined
    options.onSignal({ kind: 'finished', turn })
  }

  const settleRead = (sessionId: string, token: number, turn: FinishedTurn): void => {
    const track = sessions.get(sessionId)
    if (!track || track.read?.token !== token) {
      return
    }
    // A busy blip on the same turn holds the read until the session is idle again.
    if (track.status !== 'idle') {
      track.read.held = turn
      return
    }
    signalTurn(track, turn)
  }

  const onFinished = (
    host: StructuredTurnHost,
    sessionId: string,
    track: SessionTrack,
    turn: FinishedTurn
  ): void => {
    if (track.signalledTurnKey === turn.turnKey) {
      return
    }
    if (track.read?.turnKey === turn.turnKey) {
      if (track.read.held) {
        signalTurn(track, track.read.held)
      }
      return
    }
    const token = ++lastToken
    track.read = { turnKey: turn.turnKey, token }
    void withFullReply(host, turn).then((full) => settleRead(sessionId, token, full))
  }

  const onStatus = (host: StructuredTurnHost, summary: AgentSessionStatusSummary): void => {
    const track: SessionTrack = sessions.get(summary.sessionId) ?? { status: summary.status }
    const previous = track.unsettled ? 'working' : track.status
    track.status = summary.status
    sessions.set(summary.sessionId, track)
    evictGone(host, summary.sessionId)
    const turnFacts = host.turnState(summary.sessionId)
    const signal = classifyStructuredStatus(previous, summary, turnFacts)
    track.unsettled =
      previous === 'working' && summary.status === 'idle' && isUnsettledStructuredTurn(turnFacts)
    if (signal.kind === 'busy' || signal.kind === 'ignore') {
      options.onSignal(signal)
      return
    }
    if (signal.kind === 'finished') {
      onFinished(host, summary.sessionId, track, signal.turn)
      return
    }
    if (track.signalledTurnKey !== signal.turnKey) {
      track.signalledTurnKey = signal.turnKey
      track.read = undefined
      options.onSignal(signal)
    }
  }

  const evictGone = (host: StructuredTurnHost, keep: string): void => {
    const live = new Set(host.liveSessionStatusSummaries().map((entry) => entry.sessionId))
    for (const sessionId of sessions.keys()) {
      if (sessionId !== keep && !live.has(sessionId)) {
        sessions.delete(sessionId)
      }
    }
  }

  /** A snapshot is the live list: keep what is still there, forget the rest. */
  const onSnapshot = (summaries: readonly AgentSessionStatusSummary[]): void => {
    const live = new Set(summaries.map((summary) => summary.sessionId))
    for (const sessionId of sessions.keys()) {
      if (!live.has(sessionId)) {
        sessions.delete(sessionId)
      }
    }
    for (const summary of summaries) {
      const track = sessions.get(summary.sessionId)
      if (track) {
        track.status = summary.status
      } else {
        // What the host already knew is not a transition this process observed.
        sessions.set(summary.sessionId, { status: summary.status })
      }
    }
  }

  const attach = (host: StructuredTurnHost | null): void => {
    detach?.()
    detach = null
    sessions.clear()
    if (!host) {
      return
    }
    detach = host.subscribeStatus({
      id: SUBSCRIBER_ID,
      emit: (event) => {
        if (event.type === 'snapshot') {
          onSnapshot(event.sessions)
        } else if (event.type === 'status') {
          onStatus(host, event.session)
        }
      }
    })
  }
  attach(options.getHost())
  const unsubscribeHost = options.subscribeHostChanges(attach)
  const stop = (): void => {
    unsubscribeHost()
    detach?.()
    detach = null
    sessions.clear()
  }
  return Object.assign(stop, { tracked: () => [...sessions.keys()] })
}

/** The newest finished turn of one chat session, for the person's "Suggest next steps". */
export async function readStructuredLatestTurn(
  host: StructuredTurnHost | null,
  workspaceId: string,
  sessionId: string
): Promise<FinishedTurn | null> {
  const summary = host
    ?.liveSessionStatusSummaries()
    .find((entry) => entry.sessionId === sessionId && entry.workspaceId === workspaceId)
  if (!host || !summary) {
    return null
  }
  const signal = signalFor(host, 'working', summary)
  if (signal.kind !== 'finished') {
    return null
  }
  const conversation = structuredConversationSource(workspaceId, sessionId)
  return withFullReply(host, { ...signal.turn, conversation })
}
