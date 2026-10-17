import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { sessionWorkOwner } from '@/components/native-chat/session-work-owner'
import { useSidebarSessions } from '@/components/sidebar/session-folders/use-sidebar-sessions'
import { conversationSourceForSession } from '@/lib/conversation-source-for-session'
import { sessionTaskRef } from '@/lib/session-task-sidebar-groups'
import { useSessionTasks } from '@/store/session-task-store'
import type { ConversationSource } from '../../../../shared/conversation-source'
import type {
  NextStepDecision,
  NextStepSuggestionSet
} from '../../../../shared/next-step-suggestions'
import {
  NEXT_STEPS_POLL_MS,
  type NextStepsDecideResult
} from '../../../../shared/next-step-suggestions-rpc'
import { decideNextStepSet, listNextStepSets, suggestNextStepStart } from './next-steps-client'
import { refreshPendingNextSteps } from './next-steps-pending-store'
import { useHostSeesNoTurn } from './use-host-sees-no-turn'
import type { NextStepsNotice } from './use-next-steps-tray'

export type NextStepsStartInput = {
  worktreeId: string
  paneKey: string
  tabId: string
  /** The new session's agent; it writes the suggestions unless settings choose one. */
  agent?: string
  /** The runtime's own address for the session (a structured chat); never a guessed one. */
  conversation?: ConversationSource | null
  /** False until the surface is on screen and the conversation is still empty. */
  active: boolean
}

export type NextStepsStartState = {
  set: NextStepSuggestionSet | null
  conversation: ConversationSource | null
  sessionLabel: string
  notice: NextStepsNotice | null
  /** Why the host offered no set, when it said. */
  skipped: string | null
  setNotice: (notice: NextStepsNotice | null) => void
  requesting: boolean
  /** The host has answered at least once. */
  answered: boolean
  /** On screen, empty, and the host has observed no turn in this conversation. */
  active: boolean
  /** "Suggest again": regenerates this workspace's set for the hour. */
  suggest: () => Promise<void>
  decide: (set: NextStepSuggestionSet, decision: NextStepDecision) => Promise<NextStepsDecideResult>
}

const NO_LEDGER_CARDS: ReadonlyMap<string, string> = new Map()

function message(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

/**
 * The workspace's suggested starts for a conversation that has no message yet. Asked once when
 * the surface becomes active, then re-read only while the suggester is still writing.
 */
export function useNextStepsStart(input: NextStepsStartInput): NextStepsStartState {
  const sessions = useSidebarSessions('pane')
  const session = sessionWorkOwner(sessions, input.paneKey, input.tabId)
  // Only a real address from the sidebar or the runtime; never one guessed from the pane.
  const owned = session ? conversationSourceForSession(session) : null
  const candidate = owned ?? input.conversation ?? null
  // Only an address in this workspace, as the pill requires.
  const conversationKey = JSON.stringify(
    candidate?.worktreeId === input.worktreeId ? candidate : null
  )
  const conversation = useMemo(
    () => JSON.parse(conversationKey) as ConversationSource | null,
    [conversationKey]
  )
  // Empty on screen is not enough: the host must also have observed no turn here.
  const hostFresh = useHostSeesNoTurn(input.active ? conversation : null)
  const active = input.active && hostFresh
  const links = useSessionTasks((state) => state.links)
  const linksLoaded = useSessionTasks((state) => state.loaded)
  useEffect(() => {
    if (!linksLoaded) {
      useSessionTasks.getState().load()
    }
  }, [linksLoaded])
  const taskId = session ? sessionTaskRef(session, links, NO_LEDGER_CARDS)?.taskId : undefined

  const [set, setSet] = useState<NextStepSuggestionSet | null>(null)
  const [notice, setNotice] = useState<NextStepsNotice | null>(null)
  const [requesting, setRequesting] = useState(false)
  const [skipped, setSkipped] = useState<string | null>(null)
  const [answered, setAnswered] = useState(false)
  const request = useCallback(
    async (force: boolean) => {
      setRequesting(true)
      try {
        const result = await suggestNextStepStart({
          worktreeId: input.worktreeId,
          ...(taskId ? { taskId } : {}),
          ...(input.agent ? { agent: input.agent } : {}),
          force
        })
        setSet(result.set)
        setSkipped(result.set ? null : result.skipped)
        if (!result.set && force) {
          setNotice({ tone: 'info', lines: [result.skipped] })
        }
      } catch (failure) {
        // An older host has no `nextSteps.suggestStart`; only a click says why.
        if (force) {
          setNotice({ tone: 'error', lines: [message(failure)] })
        }
      } finally {
        setRequesting(false)
        setAnswered(true)
      }
    },
    [input.agent, input.worktreeId, taskId]
  )

  // Why wait for the task links: a card-launched session's first ask should carry its card.
  const askedFor = useRef<string | null>(null)
  const askedWithCard = useRef(false)
  useEffect(() => {
    if (!active || !linksLoaded || askedFor.current === input.worktreeId) {
      return
    }
    askedFor.current = input.worktreeId
    askedWithCard.current = Boolean(taskId)
    void request(false)
  }, [active, input.worktreeId, linksLoaded, request, taskId])
  // The card link can land after the first ask: ask once more so the card reaches the suggester.
  // Why not while generating: a forced retry would cancel the call in flight; wait for it.
  const retryable = !set || set.status === 'pending' || set.status === 'failed'
  useEffect(() => {
    if (!active || !taskId || askedWithCard.current || askedFor.current === null || !answered) {
      return
    }
    if (!retryable) {
      return
    }
    askedWithCard.current = true
    void request(true)
  }, [answered, active, request, retryable, taskId])

  const generatingId = set?.status === 'generating' ? set.id : null
  useEffect(() => {
    if (!generatingId || !active) {
      return
    }
    let cancelled = false
    const timer = setInterval(() => {
      listNextStepSets({ worktreeId: input.worktreeId }).then(
        (result) => {
          const current = result.sets.find((candidate) => candidate.id === generatingId)
          if (!cancelled && current) {
            setSet(current)
          }
        },
        () => undefined
      )
    }, NEXT_STEPS_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [generatingId, active, input.worktreeId])

  const decide = useCallback(
    async (target: NextStepSuggestionSet, decision: NextStepDecision) => {
      if (!conversation) {
        throw new Error(
          translate(
            'nextStepsStart.noConversation',
            'This conversation is still starting. Try again in a moment.'
          )
        )
      }
      // Every answer to a start set names the conversation that takes it.
      const result = await decideNextStepSet(target.id, decision, conversation)
      setSet(result.set)
      refreshPendingNextSteps()
      return result
    },
    [conversation]
  )

  return {
    set,
    conversation,
    sessionLabel: session?.label ?? translate('nextSteps.thisConversation', 'this conversation'),
    notice,
    skipped,
    setNotice,
    requesting,
    answered,
    active,
    suggest: () => request(true),
    decide
  }
}
