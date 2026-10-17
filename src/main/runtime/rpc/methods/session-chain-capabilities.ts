import { defineMethod } from '../core'

/**
 * What this execution host can durably bind. Extracted from session-chains so the outcome method
 * list keeps room for new commit fields; the payload itself is unchanged wire compatibility.
 */
export const SESSION_CHAIN_CAPABILITIES_METHOD = defineMethod({
  name: 'sessionChain.outcomeCapabilities',
  params: null,
  handler: (_params, { runtime }) => ({
    version: 1,
    taskAttachment: 1,
    planVersions: 1,
    sessionFinish: 1,
    handoffFolders: 1,
    handoffAttachments: 1,
    handoffAgents: 1,
    teamPlans: 1,
    sourceReviewRepairs: 1,
    inferredReviewPlans: 1,
    // Conversational waits: `event` conditions, approve-only reviews, owner wait choices.
    eventWaits: 1,
    // A wait on another local session's result (`event.source: 'session'`); older hosts omit it.
    sessionWaits: 1,
    executionRuntimeId: runtime.getRuntimeId(),
    remoteRuntimeOwnership: 1,
    upNextRemoteOwnership: 1,
    ompSessionExit: 1,
    placementScope: 'runtime-local',
    relaySshContinuation: false,
    durableContinuation: runtime.hasSessionOutcomeContinuation(),
    // WP-4b: a step may continue the conversation it was planned from. It needs this host to own
    // the pursuit durably — the turn is delivered and settled by the host tick, not by a renderer
    // — so the same reading that admits durable continuation admits the route. Whether the
    // conversation itself is still local and observable is the plan validator's question
    // (`ctx.source`), asked per plan, and the executor refuses again at launch if it has gone.
    sameConversationRoute: runtime.hasSessionOutcomeContinuation(),
    executionOwner: 'host-process',
    supportedEvidence: [
      'file',
      'command',
      'deployment',
      'review',
      'report',
      'session',
      'pr',
      'merge',
      'handoff',
      'event'
    ],
    ...(!runtime.hasSessionOutcomeContinuation()
      ? { reason: 'Independent execution-host continuation is not configured.' }
      : {})
  })
})
