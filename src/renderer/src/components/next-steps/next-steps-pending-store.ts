import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { useAppStore } from '@/store'
import {
  conversationSourceRowKey,
  type ConversationSource
} from '../../../../shared/conversation-source'
import type { NextStepKeepGoingState } from '../../../../shared/next-step-keep-going'
import type { NextStepSuggestionSet } from '../../../../shared/next-step-suggestions'
import { listNextStepSets } from './next-steps-client'
import { nextStepsDocumentVisible, startNextStepsPoll } from './next-steps-poll'
import { readRemoteReplyDecisions, type ProjectedReplyDecision } from './remote-reply-decisions'
import {
  captureLocalReplyDecisionSources,
  projectLocalReplyDecisions
} from './local-reply-decisions'

type PendingNextSteps = {
  /** Suggestions offered by each conversation's newest pending set, by conversation row key. */
  counts: ReadonlyMap<string, number>
  /** "Keep going" per conversation row key, on or last stopped. */
  keepGoing: ReadonlyMap<string, NextStepKeepGoingState>
  /** The stop each conversation's person has since acted past, by its `stoppedAt`. */
  keepGoingStopsSeen: ReadonlyMap<string, number>
  keepGoingRevision: number | null
  /** Each conversation's newest pending set, by conversation row key: the Attention inbox. */
  sets?: ReadonlyMap<string, NextStepSuggestionSet>
  replyDecisions?: readonly ProjectedReplyDecision[]
  remoteReplyDecisions?: readonly ProjectedReplyDecision[]
  revision: number | null
  /** The last read failed: counts are unknown, and no badge claims a number. */
  unknown: boolean
}

export const usePendingNextSteps = create<PendingNextSteps>(() => ({
  counts: new Map(),
  keepGoing: new Map(),
  keepGoingStopsSeen: new Map(),
  keepGoingRevision: null,
  revision: null,
  unknown: false
}))

function keepGoingByKey(
  states: readonly NextStepKeepGoingState[] | undefined
): Map<string, NextStepKeepGoingState> {
  return new Map(
    (states ?? []).map((state) => [conversationSourceRowKey(state.conversation), state])
  )
}

/** The person acted in this conversation's tray: its last "Keep going" stop line is cleared. */
export function acknowledgeNextStepKeepGoingStop(
  conversation: Pick<ConversationSource, 'worktreeId' | 'paneKey'>
): void {
  const key = conversationSourceRowKey(conversation)
  const stoppedAt = usePendingNextSteps.getState().keepGoing.get(key)?.stoppedAt
  if (stoppedAt !== undefined) {
    usePendingNextSteps.setState((current) => ({
      keepGoingStopsSeen: new Map(current.keepGoingStopsSeen).set(key, stoppedAt)
    }))
  }
}

/** Shows a state the host just returned, before the next poll confirms it. */
export function noteNextStepKeepGoing(state: NextStepKeepGoingState): void {
  usePendingNextSteps.setState((current) => ({
    keepGoing: new Map(current.keepGoing).set(conversationSourceRowKey(state.conversation), state)
  }))
}

/** The newest pending set per conversation, the reply's own steps before the AI's. */
export function pendingNextStepCounts(sets: readonly NextStepSuggestionSet[]): Map<string, number> {
  return new Map(
    [...pendingNextStepSetsByConversation(sets)].map(([key, set]) => [key, set.suggestions.length])
  )
}

export function pendingNextStepSetsByConversation(
  sets: readonly NextStepSuggestionSet[]
): Map<string, NextStepSuggestionSet> {
  const best = new Map<string, NextStepSuggestionSet>()
  for (const set of sets) {
    if (set.status !== 'pending' || !set.conversation || !set.suggestions.length) {
      continue
    }
    const key = conversationSourceRowKey(set.conversation)
    const current = best.get(key)
    const rank = (candidate: NextStepSuggestionSet) => (candidate.origin === 'parsed' ? 1 : 0)
    if (
      !current ||
      rank(set) > rank(current) ||
      (rank(set) === rank(current) && set.createdAt > current.createdAt)
    ) {
      best.set(key, set)
    }
  }
  return best
}

let subscribers = 0
let stopPoll: (() => void) | null = null
let issued = 0
let applied = 0
let decisionSubscribers = 0
let remoteRead: Promise<void> | null = null

/** A read the host never answers counts as a failed one, so badges stop claiming a number. */
export const NEXT_STEPS_PENDING_TIMEOUT_MS = 10_000

function withinTimeout<T>(read: Promise<T>): Promise<T> {
  // Why: a read that loses the race must not surface later as an unhandled rejection.
  read.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('The host did not answer in time.')),
      NEXT_STEPS_PENDING_TIMEOUT_MS
    )
  })
  return Promise.race([read, timeout]).finally(() => clearTimeout(timer))
}

function readPending(): void {
  if (!nextStepsDocumentVisible()) {
    return
  }
  readDecisionHosts()
  // Why a generation: a slow older answer must never overwrite a newer one.
  const generation = ++issued
  const captured =
    decisionSubscribers > 0
      ? captureLocalReplyDecisionSources(useAppStore.getState())
      : new Map<string, string>()
  Promise.resolve()
    .then(() => withinTimeout(listNextStepSets({ statuses: ['pending'] })))
    .then(
      (result) => {
        if (generation < applied) {
          return
        }
        applied = generation
        const state = usePendingNextSteps.getState()
        const keepGoingRevision = result.keepGoingRevision ?? null
        const replyDecisions =
          decisionSubscribers > 0
            ? projectLocalReplyDecisions(
                result.replyDecisions ?? [],
                captured,
                useAppStore.getState()
              )
            : []
        // A host that sends no keep-going revision cannot say it is unchanged: always refresh.
        if (
          result.revision !== state.revision ||
          keepGoingRevision === null ||
          keepGoingRevision !== state.keepGoingRevision ||
          JSON.stringify(replyDecisions) !== JSON.stringify(state.replyDecisions ?? []) ||
          state.unknown
        ) {
          const sets = pendingNextStepSetsByConversation(result.sets)
          usePendingNextSteps.setState({
            counts: new Map([...sets].map(([key, set]) => [key, set.suggestions.length])),
            sets,
            replyDecisions,
            keepGoing: keepGoingByKey(result.keepGoing),
            keepGoingRevision,
            revision: result.revision,
            unknown: false
          })
        }
      },
      () => {
        if (generation < applied) {
          return
        }
        applied = generation
        // Keep going's last known state stays shown (as unknown); a failed read is not a stop.
        usePendingNextSteps.setState({
          counts: new Map(),
          sets: undefined,
          replyDecisions: undefined,
          revision: null,
          unknown: true
        })
      }
    )
}

/** Same timer, independent results: one unreachable peer must not delay the local sidebar. */
function readDecisionHosts(): void {
  if (decisionSubscribers === 0 || remoteRead) {
    return
  }
  remoteRead = withinTimeout(readRemoteReplyDecisions())
    .then(
      (remoteReplyDecisions) => {
        if (decisionSubscribers > 0) {
          usePendingNextSteps.setState({ remoteReplyDecisions })
        }
      },
      () => usePendingNextSteps.setState({ remoteReplyDecisions: [] })
    )
    .finally(() => {
      remoteRead = null
    })
}

/** Refreshes the counts now, e.g. after this client answered a set. */
export function refreshPendingNextSteps(): void {
  if (subscribers > 0) {
    readPending()
  }
}

// Why one shared poll: every sidebar row and terminal pane asks, but the host answers once.
function subscribe(): () => void {
  subscribers += 1
  if (subscribers === 1) {
    stopPoll = startNextStepsPoll(readPending)
  }
  return () => {
    subscribers -= 1
    if (subscribers === 0) {
      stopPoll?.()
      stopPoll = null
    }
  }
}

/** How many next steps this conversation's pending set offers; null while that is unknown. */
export function usePendingNextStepCount(
  conversation: Pick<ConversationSource, 'worktreeId' | 'paneKey'> | null
): number | null {
  useEffect(() => subscribe(), [])
  const key = conversation ? conversationSourceRowKey(conversation) : null
  return usePendingNextSteps((state) =>
    state.unknown || state.revision === null ? null : key ? (state.counts.get(key) ?? 0) : 0
  )
}

/** This conversation's newest pending set (the reply's own steps first); null when none is known. */
export function usePendingNextStepSet(
  conversation: Pick<ConversationSource, 'worktreeId' | 'paneKey'> | null
): NextStepSuggestionSet | null {
  useEffect(() => subscribe(), [])
  const key = conversation ? conversationSourceRowKey(conversation) : null
  return usePendingNextSteps((state) =>
    state.unknown || !key ? null : (state.sets?.get(key) ?? null)
  )
}

/** This conversation's "Keep going" state; null when it was never turned on here. */
export function useNextStepKeepGoing(
  conversation: Pick<ConversationSource, 'worktreeId' | 'paneKey'> | null
): NextStepKeepGoingState | null {
  useEffect(() => subscribe(), [])
  const key = conversation ? conversationSourceRowKey(conversation) : null
  return usePendingNextSteps((state) => (key ? (state.keepGoing.get(key) ?? null) : null))
}

/** Whether this conversation's last "Keep going" stop is still news to the person. */
export function useNextStepKeepGoingStopShown(
  conversation: Pick<ConversationSource, 'worktreeId' | 'paneKey'> | null
): boolean {
  const key = conversation ? conversationSourceRowKey(conversation) : null
  return usePendingNextSteps((state) => {
    const stoppedAt = key ? state.keepGoing.get(key)?.stoppedAt : undefined
    return stoppedAt !== undefined && state.keepGoingStopsSeen.get(key!) !== stoppedAt
  })
}

/** Whether "Keep going" is on for this conversation, for the pill and the sidebar badge. */
export function useNextStepKeepGoingRunning(
  conversation: Pick<ConversationSource, 'worktreeId' | 'paneKey'> | null
): boolean {
  return useNextStepKeepGoing(conversation)?.enabled === true
}

/** True until the first read lands, and while the last read failed: nothing current is known. */
export function useNextStepsUnknown(): boolean {
  useEffect(() => subscribe(), [])
  return usePendingNextSteps((state) => state.unknown || state.revision === null)
}

export type PendingNextStepSets =
  | { state: 'loading' }
  | { state: 'unknown' }
  | { state: 'known'; sets: ReadonlyMap<string, NextStepSuggestionSet> }

const LOADING: PendingNextStepSets = { state: 'loading' }
const UNKNOWN: PendingNextStepSets = { state: 'unknown' }
const NO_PENDING_SETS: ReadonlyMap<string, NextStepSuggestionSet> = new Map()

/**
 * Every conversation's newest pending set, from the same shared poll as the badges. A failed read
 * is `unknown`, never an empty inbox.
 */
export function usePendingNextStepSets(): PendingNextStepSets {
  useEffect(() => subscribe(), [])
  const unknown = usePendingNextSteps((state) => state.unknown)
  const loaded = usePendingNextSteps((state) => state.revision !== null)
  const sets = usePendingNextSteps((state) => state.sets ?? NO_PENDING_SETS)
  if (unknown) {
    return UNKNOWN
  }
  return loaded ? { state: 'known', sets } : LOADING
}

const NO_REPLY_DECISIONS: readonly ProjectedReplyDecision[] = []

/** Current explicit questions share the existing poll; an old or unreachable host makes no claim. */
export function useCurrentReplyDecisions(): readonly ProjectedReplyDecision[] {
  useEffect(() => {
    decisionSubscribers += 1
    const unsubscribe = subscribe()
    readDecisionHosts()
    return () => {
      decisionSubscribers -= 1
      unsubscribe()
    }
  }, [])
  const local = usePendingNextSteps((state) =>
    state.unknown || state.revision === null
      ? NO_REPLY_DECISIONS
      : (state.replyDecisions ?? NO_REPLY_DECISIONS)
  )
  const remote = usePendingNextSteps((state) => state.remoteReplyDecisions ?? NO_REPLY_DECISIONS)
  return useMemo(() => [...local, ...remote], [local, remote])
}
