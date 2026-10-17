// `nextSteps.*` — suggested next steps for one conversation.
//
// Asking for suggestions, answering them and offering parsed ones are the person's decisions, so
// they pass the same `assertSessionOutcomeUser` gate as the prompt queue. `list` discloses only
// what the profile already holds and admits any local caller that asserts no agent authority.

import { z } from 'zod'
import {
  normalizeConversationSource,
  type ConversationSource
} from '../../../../shared/conversation-source'
import { NEXT_STEP_AD_PAUSES } from '../../../../shared/next-step-ad-pauses'
import {
  NEXT_STEP_KEEP_GOING_MAX_ROUNDS,
  NEXT_STEP_KEEP_GOING_MIN_ROUNDS,
  NEXT_STEP_KEEP_GOING_MODES,
  NEXT_STEP_KEEP_GOING_PUSH_PROMPT_MAX_LENGTH
} from '../../../../shared/next-step-keep-going'
import {
  NEXT_STEP_SUGGESTION_MAX,
  type NextStepSuggestionSetStatus
} from '../../../../shared/next-step-suggestions'
import { NEXT_STEPS_RPC } from '../../../../shared/next-step-suggestions-rpc'
import { readOfferedNextSteps } from '../../../next-steps/next-step-decisions'
import type { NextStepKeepGoingController } from '../../../next-steps/next-step-keep-going'
import {
  getNextStepKeepGoingController,
  getNextStepSuggestionService
} from '../../../next-steps/next-step-suggestion-slot'
import { routeNextStepDecision } from '../../../next-steps/next-step-start-decide'
import { suggestNextStepStart } from '../../../next-steps/next-step-start-sets'
import {
  currentNextStepTurn,
  currentNextSteps,
  offerParsedForReply
} from '../../../next-steps/next-step-turn-answers'
import type { NextStepSuggestionService } from '../../../next-steps/next-step-suggestion-service'
import { currentReplyDecisions } from '../../../next-steps/next-step-current-decisions'
import { getNextStepJev } from '../../../next-steps/next-step-jev-slot'
import { assertSessionOutcomeUser } from '../../session-outcome-authority'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'
import { requiredString } from '../schemas'

const ConversationParams = z
  .object({
    worktreeId: requiredString('Missing workspace'),
    paneKey: requiredString('Missing conversation pane'),
    kind: z.enum(['pty', 'structured']),
    sessionId: z.string().min(1).max(512).optional()
  })
  .strict()

const SuggestionIds = z.array(z.string().min(1).max(64)).min(1).max(NEXT_STEP_SUGGESTION_MAX)

export const NextStepDecisionParams = z.discriminatedUnion('action', [
  z
    // No `auto`: only the host's own Keep going decides automatically, never a caller.
    .object({ action: z.literal('run'), suggestionIds: SuggestionIds })
    .strict(),
  z.object({ action: z.literal('save'), suggestionIds: SuggestionIds }).strict(),
  z.object({ action: z.literal('dismiss') }).strict()
])

const SET_STATUSES = [
  'generating',
  'pending',
  'accepted',
  'dismissed',
  'superseded',
  'failed'
] as const satisfies readonly NextStepSuggestionSetStatus[]

export const NextStepsListParams = z
  .object({
    worktreeId: z.string().min(1).optional(),
    conversation: ConversationParams.optional(),
    // A sidebar-wide poll asks only for open sets, so it stays small however long the store is.
    statuses: z.array(z.enum(SET_STATUSES)).min(1).max(SET_STATUSES.length).optional()
  })
  .strict()

export const NextStepsGenerateParams = z
  .object({ conversation: ConversationParams, force: z.boolean().optional() })
  .strict()

export const NextStepsDecideParams = z
  .object({
    setId: requiredString('Missing suggestion set'),
    decision: NextStepDecisionParams,
    // A start set answered from inside the new conversation that takes it.
    conversation: ConversationParams.optional()
  })
  .strict()

export const NextStepsSuggestStartParams = z
  .object({
    worktreeId: requiredString('Missing workspace'),
    taskId: z.string().min(1).max(200).optional(),
    agent: z.string().min(1).max(64).optional(),
    force: z.boolean().optional()
  })
  .strict()

export const NextStepsOfferParsedParams = z
  .object({
    conversation: ConversationParams,
    // The reply the steps were read from; only used for agents that report no turns.
    messageId: requiredString('Missing reply').pipe(z.string().max(500)),
    // Items are validated one by one downstream, so one bad item does not void the offer.
    suggestions: z.array(z.unknown()).min(1).max(NEXT_STEP_SUGGESTION_MAX)
  })
  .strict()

export const NextStepsCurrentParams = z.object({ conversation: ConversationParams }).strict()

export const NextStepsLinkTaskParams = z
  .object({
    conversation: ConversationParams,
    // The hub card the client's sidebar links; null unlinks. Only JEV's goal reads it.
    taskId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,200}$/)
      .nullable()
  })
  .strict()

export const NextStepsKeepGoingParams = z
  .object({
    conversation: ConversationParams,
    enabled: z.boolean(),
    maxRounds: z
      .number()
      .int()
      .min(NEXT_STEP_KEEP_GOING_MIN_ROUNDS)
      .max(NEXT_STEP_KEEP_GOING_MAX_ROUNDS)
      .optional(),
    /** Turning it off because the person acted in the tray, before that action runs. */
    reason: z.enum(['person-acted', 'person-typing']).optional(),
    /** Absent = `next-step`; "Push for better" sends `pushPrompt` (or the saved one) each round. */
    mode: z.enum(NEXT_STEP_KEEP_GOING_MODES).optional(),
    pushPrompt: z.string().max(NEXT_STEP_KEEP_GOING_PUSH_PROMPT_MAX_LENGTH).optional()
  })
  .strict()

/** One conversation's ad-pause choice; null follows the global setting. */
export const NextStepsAdPausesParams = z
  .object({ conversation: ConversationParams, adPauses: z.enum(NEXT_STEP_AD_PAUSES).nullable() })
  .strict()

function assertReader(context: RpcContext): void {
  if (context.orchestrationCapability || context.orchestrationCompatibilityEvidence) {
    throw new Error('This read requires the user interface, not an agent assertion.')
  }
}

function requireService(): NextStepSuggestionService {
  const service = getNextStepSuggestionService()
  if (!service) {
    throw new Error('Suggested next steps are not available on this host.')
  }
  return service
}

function requireKeepGoing(): NextStepKeepGoingController {
  const controller = getNextStepKeepGoingController()
  if (!controller) {
    throw new Error('Keep going is not available on this host.')
  }
  return controller
}

function conversationOf(input: z.infer<typeof ConversationParams>): ConversationSource {
  const source = normalizeConversationSource(input)
  if (!source) {
    throw new Error('That conversation cannot be addressed on this host.')
  }
  return source
}

export const NEXT_STEPS_METHODS: RpcMethod[] = [
  defineMethod({
    name: NEXT_STEPS_RPC.list,
    params: NextStepsListParams,
    handler: (params, context) => {
      assertReader(context)
      const filter = {
        ...(params.worktreeId ? { worktreeId: params.worktreeId } : {}),
        ...(params.conversation ? { conversation: conversationOf(params.conversation) } : {})
      }
      const service = requireService()
      const listFilter = {
        ...filter,
        ...(params.statuses ? { statuses: params.statuses } : {})
      }
      return currentReplyDecisions(service, service.list(listFilter).sets, listFilter).then(
        (replyDecisions) => {
          const result = {
            ...service.list(listFilter),
            replyDecisions,
            executionRuntimeId: context.runtime.getRuntimeId()
          }
          const keepGoing = getNextStepKeepGoingController()
          return keepGoing
            ? {
                ...result,
                keepGoing: keepGoing.list(filter),
                keepGoingRevision: keepGoing.revision
              }
            : result
        }
      )
    }
  }),
  defineMethod({
    name: NEXT_STEPS_RPC.generate,
    params: NextStepsGenerateParams,
    handler: (params, context) => {
      assertSessionOutcomeUser(context)
      return requireService().generate(conversationOf(params.conversation), {
        force: params.force === true
      })
    }
  }),
  defineMethod({
    name: NEXT_STEPS_RPC.decide,
    params: NextStepsDecideParams,
    handler: (params, context) => {
      assertSessionOutcomeUser(context)
      const service = requireService()
      const set = service.deps.store.get(params.setId)
      // Every answer through this door is the person's, whatever it claims: stop Keep going first.
      if (set) {
        getNextStepKeepGoingController()?.onPersonDecided(set)
      }
      // Routed by the stored set's origin, never by whether a conversation was sent.
      return routeNextStepDecision(
        service,
        params.setId,
        params.decision,
        params.conversation ? conversationOf(params.conversation) : undefined
      )
    }
  }),
  defineMethod({
    name: NEXT_STEPS_RPC.offerParsed,
    params: NextStepsOfferParsedParams,
    handler: async (params, context) => {
      assertSessionOutcomeUser(context)
      const result = await offerParsedForReply(
        requireService(),
        conversationOf(params.conversation),
        params.messageId,
        readOfferedNextSteps(params.suggestions)
      )
      return typeof result === 'string' ? { set: null, refused: result } : { set: result }
    }
  }),
  defineMethod({
    name: NEXT_STEPS_RPC.current,
    params: NextStepsCurrentParams,
    handler: (params, context) => {
      assertReader(context)
      const conversation = conversationOf(params.conversation)
      const keepGoing = getNextStepKeepGoingController()
      return currentNextSteps(requireService(), conversation).then((result) => {
        const state = keepGoing?.list({ conversation })[0]
        return keepGoing
          ? {
              ...result,
              keepGoingRevision: keepGoing.revision,
              ...(state ? { keepGoing: state } : {})
            }
          : result
      })
    }
  }),
  defineMethod({
    name: NEXT_STEPS_RPC.keepGoing,
    params: NextStepsKeepGoingParams,
    handler: async (params, context) => {
      assertSessionOutcomeUser(context)
      const controller = requireKeepGoing()
      const conversation = conversationOf(params.conversation)
      // Turning it on reads the current turn first (after a restart it is read back); an
      // unknown turn stops it on the first check.
      if (params.enabled) {
        await currentNextStepTurn(requireService(), conversation)
      }
      return {
        state: controller.setKeepGoing(
          conversation,
          params.enabled,
          params.maxRounds,
          params.reason ?? 'person-stopped',
          {
            ...(params.mode ? { mode: params.mode } : {}),
            ...(params.pushPrompt !== undefined ? { pushPrompt: params.pushPrompt } : {})
          }
        )
      }
    }
  }),
  defineMethod({
    name: NEXT_STEPS_RPC.adPauses,
    params: NextStepsAdPausesParams,
    handler: (params, context) => {
      assertSessionOutcomeUser(context)
      const conversation = conversationOf(params.conversation)
      return { state: requireKeepGoing().setAdPauses(conversation, params.adPauses) }
    }
  }),
  defineMethod({
    name: NEXT_STEPS_RPC.linkTask,
    params: NextStepsLinkTaskParams,
    handler: (params, context) => {
      assertSessionOutcomeUser(context)
      getNextStepJev()?.linkTask(conversationOf(params.conversation), params.taskId)
      return { ok: true as const }
    }
  }),
  defineMethod({
    name: NEXT_STEPS_RPC.suggestStart,
    params: NextStepsSuggestStartParams,
    handler: (params, context) => {
      assertSessionOutcomeUser(context)
      return suggestNextStepStart(requireService(), {
        worktreeId: params.worktreeId,
        ...(params.taskId ? { taskId: params.taskId } : {}),
        ...(params.agent ? { agent: params.agent } : {}),
        force: params.force === true
      })
    }
  })
]
