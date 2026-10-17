// `sessionSteward.*` — the steward's suggestions and accuracy-guard pauses, answered in Work.
// Only the desktop window may say Yes, Dismiss or Resume: that is the person, present.

import {
  SESSION_STEWARD_RPC,
  StewardResumeOrganizeParamsSchema,
  StewardSuggestionDecisionParamsSchema,
  StewardSuggestionsParamsSchema,
  type StewardSuggestionsResult
} from '../../../../shared/session-steward-suggestions'
import { getProfileUserDataPath } from '../../../omni-profiles/profile-storage-paths'
import { stewardAccuracyGuardFor } from '../../../session-steward/organize/steward-accuracy-guard'
import { acceptStewardSuggestion } from '../../../session-steward/organize/steward-suggestion-accept'
import { stewardSuggestionsFor } from '../../../session-steward/organize/steward-suggestions-store'
import { defineMethod, type RpcMethod } from '../core'
import {
  assertOrganizationLocalReader,
  assertOrganizationWindowCaller
} from './session-organization'

function suggestions() {
  return stewardSuggestionsFor(getProfileUserDataPath())
}

function guard() {
  return stewardAccuracyGuardFor(getProfileUserDataPath())
}

export const SESSION_STEWARD_SUGGESTION_METHODS: RpcMethod[] = [
  defineMethod({
    name: SESSION_STEWARD_RPC.suggestions,
    params: StewardSuggestionsParamsSchema,
    handler: async (params, context): Promise<StewardSuggestionsResult> => {
      assertOrganizationLocalReader(context)
      const open = await suggestions().open()
      return {
        suggestions: params.kinds
          ? open.filter((entry) => params.kinds!.includes(entry.kind))
          : open,
        paused: guard().notices()
      }
    }
  }),
  defineMethod({
    name: SESSION_STEWARD_RPC.acceptSuggestion,
    params: StewardSuggestionDecisionParamsSchema,
    handler: async (params, context) => {
      assertOrganizationWindowCaller(context)
      return acceptStewardSuggestion(suggestions(), params.id)
    }
  }),
  defineMethod({
    name: SESSION_STEWARD_RPC.dismissSuggestion,
    params: StewardSuggestionDecisionParamsSchema,
    handler: async (params, context) => {
      assertOrganizationWindowCaller(context)
      return { suggestion: await suggestions().dismiss(params.id) }
    }
  }),
  defineMethod({
    name: SESSION_STEWARD_RPC.resumeOrganize,
    params: StewardResumeOrganizeParamsSchema,
    handler: async (params, context) => {
      assertOrganizationWindowCaller(context)
      return guard().resume(params.feature)
    }
  })
]
