import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { sessionWorkOwner } from '@/components/native-chat/session-work-owner'
import { useSidebarSessions } from '@/components/sidebar/session-folders/use-sidebar-sessions'
import { conversationSourceForSession } from '@/lib/conversation-source-for-session'
import type { ConversationSource } from '../../../../shared/conversation-source'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type {
  NextStepDecision,
  NextStepSuggestionSet
} from '../../../../shared/next-step-suggestions'
import {
  NEXT_STEPS_POLL_MS,
  type NextStepsDecideResult
} from '../../../../shared/next-step-suggestions-rpc'
import { decideNextStepSet, generateNextStepSet, offerParsedNextStepSet } from './next-steps-client'
import { refreshPendingNextSteps } from './next-steps-pending-store'
import {
  latestNextStepsReply,
  resolveNextStepsTrayView,
  type NextStepsReply,
  type NextStepsTrayView
} from './next-steps-tray-model'
import { useNextStepsCurrent } from './use-next-steps-current'
import { useNextStepTaskLink } from './use-next-step-task-link'
import type { NextStepDoneness } from '../../../../shared/next-step-doneness'

export type NextStepsTrayInput = {
  paneKey: string
  tabId: string
  /** The transcript; absent on the Terminal view, where the host's pending set is shown. */
  messages?: readonly NativeChatMessage[]
  disabled: boolean
  visible?: boolean
  /** Used when no sidebar row owns the pane yet. */
  conversation?: ConversationSource | null
}

export type NextStepsNotice = { tone: 'error' | 'warning' | 'info'; lines: string[] }

/** Offers of one reply that may fail before the tray stops trying. */
export const NEXT_STEPS_OFFER_ATTEMPTS = 3
/** How long a reply waits for its turn to be reported before the fallback offer. */
export const NEXT_STEPS_OFFER_GRACE_MS = 5_000

export type NextStepsTrayState = {
  conversation: ConversationSource | null
  sessionLabel: string
  reply: NextStepsReply | null | undefined
  view: NextStepsTrayView
  /** JEV's advisory doneness reading for the current turn, when the host has one. */
  doneness: NextStepDoneness | null
  /** Why the host's sets could not be read or the reply's steps not registered; quiet. */
  problem: string | null
  notice: NextStepsNotice | null
  setNotice: (notice: NextStepsNotice | null) => void
  suggesting: boolean
  /** `again` is the explicit "Suggest again": it overrides the skip rules, never an answer. */
  suggest: (again?: boolean) => Promise<void>
  /** Null when an answer to this set is already in flight: one decide per set at a time. */
  decide: (
    set: NextStepSuggestionSet,
    decision: NextStepDecision
  ) => Promise<NextStepsDecideResult | null>
}

export function useNextStepsTray(input: NextStepsTrayInput): NextStepsTrayState {
  const sessions = useSidebarSessions('pane')
  const session = sessionWorkOwner(sessions, input.paneKey, input.tabId)
  const owned = session ? conversationSourceForSession(session) : null
  const conversationKey = JSON.stringify(owned ?? input.conversation ?? null)
  const conversation = useMemo(
    () => JSON.parse(conversationKey) as ConversationSource | null,
    [conversationKey]
  )
  const reply = useMemo(
    () => (input.messages ? latestNextStepsReply(input.messages) : undefined),
    [input.messages]
  )
  const host = useNextStepsCurrent(conversation, (input.visible ?? true) && !input.disabled)
  useNextStepTaskLink(session, conversation)
  const { current, loaded, error, upsert, refresh } = host
  const view = resolveNextStepsTrayView(current, reply ?? undefined)

  // Fallback for an agent the host never sees finish a turn: after a grace period with no
  // observed turn, offer the reply's own steps. One attempt per poll tick, a bounded number.
  const [offerError, setOfferError] = useState<{ messageId: string; error: string } | null>(null)
  const replyId = reply?.messageId
  const replySuggestions = reply?.suggestions
  const eligible =
    loaded && !error && current?.turnObserved === false && current.parsed?.messageId !== replyId
  const live = useRef({ eligible, replySuggestions })
  useEffect(() => {
    live.current = { eligible, replySuggestions }
  })
  const candidate = Boolean(conversation && replyId && replySuggestions?.length && !input.disabled)
  useEffect(() => {
    if (!candidate || !conversation || !replyId) {
      return
    }
    const seenAt = Date.now()
    let attempts = 0
    let inFlight = false
    let done = false
    const timer = setInterval(() => {
      const { eligible: now, replySuggestions: steps } = live.current
      if (
        done ||
        inFlight ||
        !now ||
        !steps?.length ||
        Date.now() - seenAt < NEXT_STEPS_OFFER_GRACE_MS
      ) {
        return
      }
      if (attempts >= NEXT_STEPS_OFFER_ATTEMPTS) {
        clearInterval(timer)
        return
      }
      attempts += 1
      inFlight = true
      offerParsedNextStepSet(conversation, replyId, steps).then(
        (result) => {
          inFlight = false
          // A refusal, or no answer at all, ends the fallback for this reply; it is not retried.
          done = true
          setOfferError(null)
          // The host may have seen a real turn meanwhile: its own sets win over this offer.
          if (result?.set && live.current.eligible) {
            upsert(result.set)
          }
          refresh()
        },
        (failure: unknown) => {
          inFlight = false
          setOfferError({
            messageId: replyId,
            error: failure instanceof Error ? failure.message : String(failure)
          })
        }
      )
    }, NEXT_STEPS_POLL_MS)
    return () => clearInterval(timer)
  }, [candidate, conversation, refresh, replyId, upsert])
  const offerFor = offerError?.messageId === replyId ? offerError : null

  const [notice, setNoticeState] = useState<{ for: string; notice: NextStepsNotice } | null>(null)
  const noticeFor = replyId ?? conversationKey
  const setNotice = useCallback(
    (next: NextStepsNotice | null) =>
      setNoticeState(next ? { for: noticeFor, notice: next } : null),
    [noticeFor]
  )
  const [suggesting, setSuggesting] = useState(false)
  const suggest = useCallback(
    async (again = false) => {
      if (!conversation) {
        return
      }
      setSuggesting(true)
      setNoticeState(null)
      try {
        const result = await generateNextStepSet(conversation, again)
        if (result.set) {
          upsert(result.set)
        } else {
          setNoticeState({ for: noticeFor, notice: { tone: 'info', lines: [result.skipped] } })
        }
        refresh()
      } catch (failure) {
        setNoticeState({
          for: noticeFor,
          notice: {
            tone: 'error',
            lines: [failure instanceof Error ? failure.message : String(failure)]
          }
        })
      } finally {
        setSuggesting(false)
      }
    },
    [conversation, noticeFor, refresh, upsert]
  )
  const deciding = useRef(new Set<string>())
  const decide = useCallback(
    async (set: NextStepSuggestionSet, decision: NextStepDecision) => {
      if (deciding.current.has(set.id)) {
        return null
      }
      deciding.current.add(set.id)
      try {
        const result = await decideNextStepSet(set.id, decision)
        upsert(result.set)
        return result
      } finally {
        deciding.current.delete(set.id)
        refreshPendingNextSteps()
        refresh()
      }
    },
    [refresh, upsert]
  )
  const problem = error
    ? translate('nextSteps.readFailed', 'Suggestions could not be read: {{reason}}', {
        reason: error
      })
    : offerFor && eligible
      ? translate(
          'nextSteps.offerFailed',
          'The reply’s suggestions could not be registered: {{reason}}',
          { reason: offerFor.error }
        )
      : null
  return {
    conversation,
    sessionLabel: session?.label ?? translate('nextSteps.thisConversation', 'this conversation'),
    reply,
    view,
    doneness: current?.doneness?.turnKey === current?.turnKey ? (current?.doneness ?? null) : null,
    problem,
    notice: notice?.for === noticeFor ? notice.notice : null,
    setNotice,
    suggesting,
    suggest,
    decide
  }
}
