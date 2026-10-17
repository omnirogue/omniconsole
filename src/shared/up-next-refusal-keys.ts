/**
 * Why an add button is off. Keys, not sentences: the renderer owns the words, and the
 * English source is the mockup's own wording —
 * `handoffTerminal`         "A send that doesn't wait ends this track. Tick "Wait for their OK" to keep going."
 * `handoffEndsTrack`        "A send that doesn't wait already ends this track."
 * `doneLastRemoveToAdd`     "Done is last. Remove Done to add more."
 * `doneLast`                "Done is last."
 * `doneAlreadyInTrack`      "Done is already in the track."
 * `sessionClosed`           "This session is finished."
 */
export const UP_NEXT_REASON_KEYS = {
  handoffTerminal: 'upNext.addDisabled.handoffTerminal',
  handoffEndsTrack: 'upNext.addDisabled.handoffEndsTrack',
  doneLastRemoveToAdd: 'upNext.addDisabled.doneLastRemoveToAdd',
  doneLast: 'upNext.addDisabled.doneLast',
  doneAlreadyInTrack: 'upNext.addDisabled.doneAlreadyInTrack',
  sessionClosed: 'upNext.addDisabled.sessionClosed'
} as const

/**
 * Why a write was refused. Keys again, for the same reason — the engine states the RULE and
 * the renderer says it in the person's language. English sources:
 * `unknownBlock`      "That block is no longer in Up next."
 * `wrongKind`         "That block is a different kind of block."
 * `blockRunning`      "That stage is already running. Configure a stage after it."
 * `blockQueued`       "That stage is already queued. Configure a stage after it."
 * `doneQueued`        "Done is already queued. Change how it finishes under When finished."
 * `capIsTerminal`     "The track ends here; this block cannot move."
 * `pastTerminal`      "Nothing can be placed after the end of the track."
 * `noDrafts`          "There are no new blocks to queue."
 * `needsAgent`        "Choose the agent for this stage; this conversation's agent is unknown."
 * `needsPerson`       "Choose the person this goes to."
 * `needsRelationship` "Choose hand off or review."
 * `afterReview`        "Blocks after a review are queued once the review returns."
 * `doneNeedsWork`      "There is no queued work to finish yet."
 * `subjectNotStarted`  "Start the conversation for this thread or card first."
 * `stopRuleUnsupported` "Review rounds here stop when there are no blockers left. Choose that stop rule."
 * `promptNeedsItsStage` "Queue the stage this prompt belongs to as well."
 * `dueInPast`          "That due date has passed. Choose a later date or time."
 */
export const UP_NEXT_REFUSAL_KEYS = {
  unknownBlock: 'upNext.refusal.unknownBlock',
  wrongKind: 'upNext.refusal.wrongKind',
  blockRunning: 'upNext.refusal.blockRunning',
  blockQueued: 'upNext.refusal.blockQueued',
  doneQueued: 'upNext.refusal.doneQueued',
  capIsTerminal: 'upNext.refusal.capIsTerminal',
  pastTerminal: 'upNext.refusal.pastTerminal',
  noDrafts: 'upNext.refusal.noDrafts',
  needsAgent: 'upNext.refusal.needsAgent',
  needsPerson: 'upNext.refusal.needsPerson',
  needsRelationship: 'upNext.refusal.needsRelationship',
  afterReview: 'upNext.refusal.afterReview',
  doneNeedsWork: 'upNext.refusal.doneNeedsWork',
  subjectNotStarted: 'upNext.refusal.subjectNotStarted',
  stopRuleUnsupported: 'upNext.refusal.stopRuleUnsupported',
  promptNeedsItsStage: 'upNext.refusal.promptNeedsItsStage',
  dueInPast: 'upNext.refusal.dueInPast',
  sendAfterQueued: 'upNext.refusal.sendAfterQueued'
} as const
